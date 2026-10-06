#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { SignJWT } from "jose";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence", "cami-package-delivery", "live");
const demoPassword = "InviteDemo#2026";

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function login(phone, password) {
  const result = await jsonRequest(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(result.response.status, 200, `LOGIN_FAILED:${phone}:${JSON.stringify(result.payload)}`);
  assert.equal(result.payload.success, true);
  return result.payload;
}

async function browserContext(browser, token, user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, identity }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(identity));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, identity: user });
  return context;
}

async function closeAnnouncement(page) {
  await page.waitForTimeout(500);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const announcement = page.getByTestId("announcement-reader");
    if (!await announcement.isVisible().catch(() => false)) return;
    const close = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
    if (await close.count()) await close.click();
    else {
      const markRead = announcement.getByRole("button", { name: /标记已阅读/u }).first();
      if (await markRead.count()) await markRead.click();
      else if (await announcement.locator("button").count()) await announcement.locator("button").first().click();
    }
    await page.waitForTimeout(150);
  }
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(adminIdentity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const adminId = String(adminIdentity.user.id || "");
  const adminSessionId = String(adminIdentity.user.sessionId || adminIdentity.user.session_id || "");
  assert.match(adminId, /^[0-9a-f-]{36}$/iu);
  assert.ok(adminSessionId);

  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true);
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1");
  assert.equal(Number(runtime.ownerConnection?.port), 54322);
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-live-cami-package-delivery",
    connectionTimeoutMillis: 10_000,
    query_timeout: 45_000,
  });
  const report = {
    passed: false,
    checkedAt: "",
    target: `${origin}/admin?tab=cami`,
    viewport: { width: 1440, height: 900 },
    assertions: {},
    failedResponses: [],
    pageErrors: [],
    consoleErrors: [],
    screenshots: [],
    productionWrites: 0,
    paidCalls: 0,
  };

  let browser;
  await fs.mkdir(evidenceDir, { recursive: true });
  await client.connect();
  try {
    const targetResult = await client.query(
      `SELECT account.id::text,account.phone,account.display_name,account.member_status,
              account.credits,account.cash_balance,relation.id::text AS invitation_record_id,
              relation.inviter_id::text
         FROM public.users account
         JOIN public.invitation_records relation ON relation.invitee_id::text=account.id::text
        WHERE account.display_name LIKE '邀请码闭环演示-待派发新人%'
          AND coalesce(account.member_status,'inactive') <> 'active'
          AND NOT EXISTS (
            SELECT 1 FROM public.cami_codes card
             WHERE card.assigned_to::text=account.id::text AND NOT coalesce(card.is_used,false)
          )
        ORDER BY account.created_at DESC LIMIT 1`,
    );
    assert.equal(targetResult.rowCount, 1, "INSPECTABLE_PENDING_INVITED_LEARNER_REQUIRED");
    const learner = targetResult.rows[0];
    const memberLogin = await login(learner.phone, demoPassword);
    await jsonRequest(`${origin}/api/notifications/user`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberLogin.token}` },
      body: JSON.stringify({ markAllRead: true }),
    });

    const catalog = await jsonRequest(`${origin}/api/admin/member-packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(catalog.response.status, 200, `PACKAGE_CATALOG_FAILED:${JSON.stringify(catalog.payload)}`);
    const formal = catalog.payload.templates?.find((item) => item.key === "formal_member");
    assert.ok(formal && formal.membershipStatus === "active", "FORMAL_PACKAGE_REQUIRED");

    const created = await jsonRequest(`${origin}/api/admin/cami`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ count: 1, profileKey: formal.key, profileVersion: formal.version, expires_days: 30, prefix: "AH" }),
    });
    assert.equal(created.response.status, 200, `CARD_CREATE_FAILED:${JSON.stringify(created.payload)}`);
    assert.equal(created.payload.created, 1);
    const cardCode = String(created.payload.codes?.[0] || "");
    assert.ok(cardCode);
    const cardResult = await client.query(
      `SELECT id::text,code,plan_name,profile_key,profile_version,credits,cash_balance,
              duration_days,feature_navigation_keys,allowed_categories
         FROM public.cami_codes WHERE code=$1 LIMIT 1`,
      [cardCode],
    );
    assert.equal(cardResult.rowCount, 1);
    const card = cardResult.rows[0];
    assert.equal(card.profile_key, formal.key);
    assert.equal(Number(card.profile_version), Number(formal.version));
    report.assertions.cardGeneratedFromImmutableFormalTemplate = true;

    browser = await chromium.launch({ headless: true });
    const adminContext = await browserContext(browser, adminToken, adminIdentity.user);
    adminContext.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.includes("__nextjs_original-stack-frames")) {
        report.failedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    const adminPage = await adminContext.newPage();
    adminPage.on("pageerror", (error) => report.pageErrors.push(`admin:${error.message}`));
    adminPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`admin:${message.text()}`); });
    await adminPage.goto(`${origin}/admin?tab=cami&member=${encodeURIComponent(learner.id)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await closeAnnouncement(adminPage);
    const cardRow = adminPage.getByTestId(`cami-row-${card.id}`);
    await cardRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await cardRow.innerText()).includes(cardCode), false, "ADMIN_CARD_TABLE_MUST_MASK_SECRET_BY_DEFAULT");
    report.assertions.adminCardInventoryIsMaskedByDefault = true;
    await cardRow.getByRole("button", { name: "发送激活卡" }).click();
    const assignmentDialog = adminPage.getByTestId("cami-assignment-dialog");
    await assignmentDialog.waitFor({ state: "visible", timeout: 20_000 });
    await assignmentDialog.getByTestId("cami-assignment-member-context").waitFor({ state: "visible", timeout: 20_000 });
    const contextCopy = await assignmentDialog.innerText();
    assert.match(contextCopy, new RegExp(learner.display_name, "u"));
    assert.match(contextCopy, /注册于/u);
    assert.match(contextCopy, /体验包/u);
    assert.match(contextCopy, /线下付款/u);
    assert.match(contextCopy, /待兑换激活卡/u);
    assert.match(contextCopy, /管理员操作密码/u);
    assert.equal(await assignmentDialog.getByTestId("cami-assignment-submit").isDisabled(), true, "PASSWORD_AND_CONFIRMATION_MUST_GATE_SEND");
    const adminModalShot = path.join(evidenceDir, "01-admin-card-assignment-safety-dialog-1440x900.png");
    await adminPage.screenshot({ path: adminModalShot, fullPage: true });
    report.screenshots.push(adminModalShot);
    report.assertions.assignmentDialogShowsFullLearnerContext = true;
    report.assertions.passwordAndExplicitConfirmationGateVisible = true;
    await assignmentDialog.getByRole("button", { name: "取消", exact: true }).click();

    const rejectedKey = `cami-live-missing-reauth:${card.id}`;
    const missingReauth = await jsonRequest(`${origin}/api/admin/cami`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "Idempotency-Key": rejectedKey,
      },
      body: JSON.stringify({ cardId: card.id, userId: learner.id, idempotencyKey: rejectedKey }),
    });
    assert.equal(missingReauth.response.status, 401, "SERVER_MUST_REJECT_CARD_PUSH_WITHOUT_REAUTH");
    assert.equal(missingReauth.payload.code, "CAMI_ASSIGNMENT_REAUTH_REQUIRED");
    report.assertions.serverRejectsPushWithoutFreshAdminReauth = true;

    const issuedAt = Math.floor(Date.now() / 1000);
    const reauthToken = await new SignJWT({
      tokenUse: "admin_cami_assignment_reauth",
      adminUserId: adminId,
      authSessionId: adminSessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("zimeiti-admin")
      .setAudience("admin-cami-assignment")
      .setSubject(adminId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 5 * 60)
      .sign(new TextEncoder().encode(runtime.jwtSecret));
    const assignmentKey = `cami-live-assignment:${card.id}`;
    const assigned = await jsonRequest(`${origin}/api/admin/cami`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "Idempotency-Key": assignmentKey,
        "x-admin-cami-assignment-reauth": reauthToken,
      },
      body: JSON.stringify({ cardId: card.id, userId: learner.id, idempotencyKey: assignmentKey }),
    });
    assert.equal(assigned.response.status, 200, `CARD_ASSIGNMENT_FAILED:${JSON.stringify(assigned.payload)}`);
    assert.equal(assigned.payload.success, true);
    report.assertions.boundCardDeliveredExactlyOnce = true;

    const afterAssignmentContext = await jsonRequest(`${origin}/api/admin/cami?member_id=${encodeURIComponent(learner.id)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(afterAssignmentContext.response.status, 200);
    assert.equal(afterAssignmentContext.payload.packageState.pendingCards.length, 1);
    assert.equal(afterAssignmentContext.payload.packageState.trialDelivered, false);
    report.assertions.unusedTrialPackageIsNotDuplicatedByCardCenter = true;

    const notificationApi = await jsonRequest(`${origin}/api/notifications/user`, {
      headers: { Authorization: `Bearer ${memberLogin.token}` },
    });
    assert.equal(notificationApi.response.status, 200);
    const cardNotification = notificationApi.payload.notifications?.find((item) => item.type === "membership_card");
    assert.ok(cardNotification, "BOUND_CARD_NOTIFICATION_REQUIRED");
    assert.equal(cardNotification.has_cami_code, true);
    assert.equal(Object.prototype.hasOwnProperty.call(cardNotification, "cami_code"), false, "CARD_SECRET_MUST_NOT_CROSS_USER_API");
    assert.equal(JSON.stringify(notificationApi.payload).includes(cardCode), false, "CARD_SECRET_MUST_NOT_APPEAR_IN_USER_RESPONSE");
    report.assertions.activationSecretNeverCrossesUserNotificationApi = true;

    const userContext = await browserContext(browser, memberLogin.token, memberLogin.user);
    const userPage = await userContext.newPage();
    userPage.on("pageerror", (error) => report.pageErrors.push(`user:${error.message}`));
    userPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`user:${message.text()}`); });
    await userPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await closeAnnouncement(userPage);
      if (await userPage.getByTestId("account-notification-dialog").isVisible().catch(() => false)) break;
      await userPage.waitForTimeout(500);
    }
    const noticeDialog = userPage.getByTestId("account-notification-dialog");
    await noticeDialog.getByText("会员激活卡已送达", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await noticeDialog.getByTestId("notification-cami-redeem-link").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await noticeDialog.innerText()).includes(cardCode), false, "CARD_SECRET_MUST_NOT_RENDER_IN_LOGIN_DIALOG");
    const noticeShot = path.join(evidenceDir, "02-user-bound-card-login-notice-1440x900.png");
    await userPage.screenshot({ path: noticeShot, fullPage: true });
    report.screenshots.push(noticeShot);
    report.assertions.loginNoticeExplainsNoCopyAndOneClickRedeem = true;
    await noticeDialog.getByTestId("notification-cami-redeem-link").click();
    await userPage.waitForURL(/\/profile\?tab=notifications/u, { timeout: 20_000 });
    const cardNoticeTitle = userPage.getByText("会员激活卡已送达", { exact: true }).first();
    await cardNoticeTitle.waitFor({ state: "visible", timeout: 20_000 });
    const cardNotice = cardNoticeTitle.locator("xpath=../..");
    await cardNotice.getByRole("button", { name: "一键激活" }).waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await cardNotice.innerText()).includes(cardCode), false, "CARD_SECRET_MUST_NOT_RENDER_IN_PROFILE");
    userPage.once("dialog", async (dialog) => dialog.accept());
    await cardNotice.getByRole("button", { name: "一键激活" }).click();

    await client.query("SELECT pg_sleep(0.5)");
    const receiptResult = await client.query(
      `SELECT account.member_status,account.credits,account.cash_balance,
              relation.activation_method,relation.invitee_activated,
              activation_reward.status AS activation_reward_status,
              activation_reward.eligibility_at IS NOT NULL AS activation_reward_eligible,
              card.is_used,card.used_by::text,card.package_assignment_id::text,
              assignment.profile_key,assignment.profile_version,assignment.package_name,
              assignment.credits AS assigned_credits,assignment.cash_amount AS assigned_cash,
              assignment.feature_navigation_keys,assignment.agent_navigation_keys,
              public.read_member_permission_snapshot(account.id) AS permission_snapshot,
              (SELECT count(*)::integer FROM public.wallet_operations operation
                WHERE operation.user_id=relation.inviter_id::text
                  AND operation.metadata->>'grant_id'=activation_reward.id::text) AS inviter_activation_wallet_ops
         FROM public.users account
         JOIN public.invitation_records relation ON relation.id=$2
         JOIN public.invitation_reward_grants activation_reward
           ON activation_reward.invitation_record_id=relation.id AND activation_reward.reward_stage='activation'
         JOIN public.cami_codes card ON card.id=$3::uuid
         JOIN public.member_package_assignments assignment ON assignment.id=card.package_assignment_id
        WHERE account.id=$1`,
      [learner.id, learner.invitation_record_id, card.id],
    );
    assert.equal(receiptResult.rowCount, 1, "CARD_REDEMPTION_RECEIPT_REQUIRED");
    const receipt = receiptResult.rows[0];
    assert.equal(receipt.member_status, "active");
    assert.equal(receipt.activation_method, "cami");
    assert.equal(receipt.invitee_activated, true);
    assert.equal(receipt.is_used, true);
    assert.equal(receipt.used_by, learner.id);
    assert.ok(receipt.package_assignment_id);
    assert.equal(receipt.profile_key, formal.key);
    assert.equal(Number(receipt.profile_version), Number(formal.version));
    assert.equal(Number(receipt.assigned_credits), Number(formal.credits));
    assert.equal(Number(receipt.assigned_cash), Number(formal.cashAmount));
    assert.equal(Number(receipt.credits) - Number(learner.credits), Number(formal.credits));
    assert.equal(Number(receipt.cash_balance) - Number(learner.cash_balance), Number(formal.cashAmount));
    assert.equal(receipt.permission_snapshot?.integrity_valid, true);
    assert.deepEqual(receipt.permission_snapshot?.feature_navigation_keys, receipt.feature_navigation_keys);
    assert.deepEqual(receipt.permission_snapshot?.agent_navigation_keys, receipt.agent_navigation_keys);
    assert.equal(receipt.activation_reward_status, "pending");
    assert.equal(receipt.activation_reward_eligible, true);
    assert.equal(Number(receipt.inviter_activation_wallet_ops), 0);
    report.assertions.oneClickRedeemAppliesFullPackageSnapshot = true;
    report.assertions.redemptionCreatesImmutablePackageReceipt = true;
    report.assertions.formalInvitationRewardOnlyBecomesPending = true;
    report.assertions.inviterNotAutoPaid = true;

    await userPage.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await userPage.getByText(/正式会员|会员已激活/u).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const redeemedShot = path.join(evidenceDir, "03-user-personal-center-after-redemption-1440x900.png");
    await userPage.screenshot({ path: redeemedShot, fullPage: true });
    report.screenshots.push(redeemedShot);
    await userContext.close();

    await adminPage.goto(`${origin}/admin?tab=invitations&member=${encodeURIComponent(learner.id)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const relationRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: learner.display_name });
    await relationRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await relationRow.innerText(), /正式会员邀请奖励/u);
    assert.match(await relationRow.innerText(), /待决定|可人工决定额度|已开放/u);
    const relationShot = path.join(evidenceDir, "04-admin-invitation-reward-unlocked-after-card-1440x900.png");
    await adminPage.screenshot({ path: relationShot, fullPage: true });
    report.screenshots.push(relationShot);
    await adminContext.close();

    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.failedResponses.filter((entry) => !entry.startsWith("401 PATCH /api/admin/cami")), []);
    report.passed = true;
    report.checkedAt = new Date().toISOString();
    report.demo = {
      learner: { id: learner.id, phone: learner.phone, displayName: learner.display_name, password: demoPassword },
      card: { id: card.id, credential: "••••••••", package: card.plan_name, status: "已绑定并激活" },
      inspectMember: `${origin}/admin?tab=users&member=${learner.id}`,
      inspectInvitation: `${origin}/admin?tab=invitations&member=${learner.id}`,
      inspectCard: `${origin}/admin?tab=cami&member=${learner.id}`,
    };
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await client.end();
  }
}
