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
const evidenceDir = path.resolve(".codex-evidence", "invitation-member-package-chain", "live");

const demo = {
  inviter: { phone: "18800001001", password: "InviteDemo#2026", displayName: "邀请码闭环演示-邀请人" },
  assignedInvitee: { phone: "18800001002", password: "InviteDemo#2026", displayName: "邀请码闭环演示-受邀学员" },
  pendingInvitee: {
    phone: "18800001003",
    email: "26091003@qq.com",
    username: "invitation_demo_pending",
    password: "InviteDemo#2026",
    displayName: "邀请码闭环演示-待派发新人",
  },
  automaticInvitee: {
    phone: "18800001004",
    email: "26091004@qq.com",
    username: "invitation_demo_automatic",
    password: "InviteDemo#2026",
    displayName: "邀请码闭环演示-自动体验新人",
  },
  customBenefit: {
    name: "邀请码闭环演示-自定义权益礼包",
    description: "本地功能验收：验证管理员可以自行命名并配置积分、现金、期限和访问权限。",
    durationDays: 15,
    credits: 66,
    cashAmount: 1.88,
  },
};

function pendingDemoProfile(candidateIndex) {
  const suffix = candidateIndex === 0 ? 3 : candidateIndex + 4;
  const suffixText = String(suffix).padStart(2, "0");
  return {
    phone: `188000010${suffixText}`,
    email: `260910${suffixText}@qq.com`,
    username: `invitation_demo_pending_${suffixText}`,
    password: "InviteDemo#2026",
    displayName: candidateIndex === 0
      ? "邀请码闭环演示-待派发新人"
      : `邀请码闭环演示-待派发新人-${suffixText}`,
  };
}

function automaticDemoProfile(candidateIndex) {
  const suffix = candidateIndex === 0 ? 4 : candidateIndex + 7;
  const suffixText = String(suffix).padStart(2, "0");
  return {
    phone: `188000010${suffixText}`,
    email: `260910${suffixText}@qq.com`,
    username: `invitation_demo_automatic_${suffixText}`,
    password: "InviteDemo#2026",
    displayName: candidateIndex === 0
      ? demo.automaticInvitee.displayName
      : `邀请码闭环演示-自动体验新人-${suffixText}`,
  };
}

function asNumber(value) {
  const number = Number(value);
  assert.ok(Number.isFinite(number), `FINITE_NUMBER_REQUIRED:${value}`);
  return number;
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
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
        else if (await announcement.locator("button").count()) await announcement.locator("button").first().click();
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

async function login(phone, password) {
  const result = await jsonRequest(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert.equal(result.response.status, 200, `LOGIN_FAILED:${phone}:${JSON.stringify(result.payload)}`);
  assert.equal(result.payload.success, true, `LOGIN_NOT_SUCCESSFUL:${phone}`);
  assert.ok(result.payload.token, `LOGIN_TOKEN_MISSING:${phone}`);
  return result.payload;
}

async function createAuthenticatedContext(browser, token, user, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, identity }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(identity));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, identity: user });
  return context;
}

async function registerInvitedDemoUser(client, profile, invitationCode, auditCopy) {
  const passwordHash = await bcrypt.hash(profile.password, 10);
  const registration = await client.query(
    "SELECT public.register_invited_user_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
    [
      profile.email,
      profile.phone,
      profile.username,
      passwordHash,
      profile.displayName,
      invitationCode,
      crypto.randomBytes(32).toString("hex"),
    ],
  );
  const result = registration.rows[0]?.result;
  assert.equal(result?.ok, true, `DEMO_REGISTRATION_FAILED:${profile.phone}:${JSON.stringify(result)}`);
  const userId = String(result.user?.id || "");
  assert.match(userId, /^[0-9a-f-]{36}$/iu, `DEMO_USER_ID_REQUIRED:${profile.phone}`);
  await client.query(
    `INSERT INTO public.password_audit_log(user_id,action,details)
     VALUES($1,'register',$2)`,
    [userId, auditCopy],
  );
  return userId;
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
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-invitation-member-package-chain",
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
    screenshots: [],
    productionWrites: 0,
    paidCalls: 0,
  };

  let browser;
  let originalAutomationEnabled = null;
  let currentAutomationEnabled = null;
  let notificationQueueProbeId = null;
  let pendingProfile = null;
  let automaticProfile = null;
  await fs.mkdir(evidenceDir, { recursive: true });
  await client.connect();
  try {
    const people = await client.query(
      `SELECT id::text,phone,display_name,member_status,credits,cash_balance
         FROM public.users WHERE phone=ANY($1::text[]) ORDER BY phone`,
      [[demo.inviter.phone, demo.assignedInvitee.phone]],
    );
    assert.equal(people.rowCount, 2, "RETAINED_DEMO_USERS_REQUIRED");
    const inviter = people.rows.find((row) => row.phone === demo.inviter.phone);
    const assignedInvitee = people.rows.find((row) => row.phone === demo.assignedInvitee.phone);
    assert.ok(inviter && assignedInvitee, "DEMO_USER_MAPPING_REQUIRED");

    const relationResult = await client.query(
      `SELECT id,invitation_code_snapshot,invitee_activated,reward_sent
         FROM public.invitation_records
        WHERE inviter_id=$1::uuid AND invitee_id=$2::uuid
        ORDER BY invited_at DESC LIMIT 1`,
      [inviter.id, assignedInvitee.id],
    );
    assert.equal(relationResult.rowCount, 1, "DEMO_RELATION_REQUIRED");
    const relation = relationResult.rows[0];
    const priorAssignment = await client.query(
      `SELECT id::text,package_name,notification_id::text,credits,cash_amount
         FROM public.member_package_assignments
        WHERE invitation_record_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [relation.id],
    );

    const catalog = await jsonRequest(`${origin}/api/admin/member-packages?user_id=${encodeURIComponent(assignedInvitee.id)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(catalog.response.status, 200, `PACKAGE_CATALOG_FAILED:${JSON.stringify(catalog.payload)}`);
    assert.equal(catalog.payload.policy?.newResourcesDefaultClosed, true);
    assert.equal(catalog.payload.policy?.existingAssignmentsImmutableOnRelease, true);
    assert.equal(catalog.payload.permission?.integrityValid, true, "INVITEE_PERMISSION_SNAPSHOT_REQUIRED");
    for (const packageKey of ["trial_member", "formal_member", "super_vip"]) {
      assert.ok(catalog.payload.templates.some((item) => item.key === packageKey), `PACKAGE_TEMPLATE_MISSING:${packageKey}`);
    }
    const superVipTemplate = catalog.payload.templates.find((item) => item.key === "super_vip");
    assert.ok(superVipTemplate, "SUPER_VIP_TEMPLATE_REQUIRED");
    assert.ok(catalog.payload.resources.features.length >= 9, "FEATURE_RESOURCE_CATALOG_INCOMPLETE");
    assert.ok(catalog.payload.resources.agents.length >= 5, "AGENT_RESOURCE_CATALOG_INCOMPLETE");
    report.assertions.packageCatalogAndFailClosedPolicy = true;

    const automationRead = await jsonRequest(`${origin}/api/admin/member-packages/automation`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(automationRead.response.status, 200, `PACKAGE_AUTOMATION_READ_FAILED:${JSON.stringify(automationRead.payload)}`);
    assert.equal(automationRead.payload.policy?.futureInvitedRegistrationsOnly, true);
    assert.equal(automationRead.payload.policy?.inviterRewardsRemainManual, true);
    assert.equal(automationRead.payload.policy?.formalAndVipRemainManual, true);
    assert.equal(automationRead.payload.automation?.profileKey, "trial_member");
    originalAutomationEnabled = automationRead.payload.automation?.enabled === true;
    currentAutomationEnabled = originalAutomationEnabled;
    report.assertions.singleInvitedRegistrationPackageSwitch = true;

    const inviteeLogin = await login(demo.assignedInvitee.phone, demo.assignedInvitee.password);
    await jsonRequest(`${origin}/api/notifications/user`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${inviteeLogin.token}` },
      body: JSON.stringify({ markAllRead: true }),
    });

    browser = await chromium.launch({ headless: true });
    const userLiveContext = await createAuthenticatedContext(browser, inviteeLogin.token, inviteeLogin.user, report.viewport);
    const userLivePage = await userLiveContext.newPage();
    userLivePage.on("pageerror", (error) => report.pageErrors.push(`user-live:${error.message}`));
    userLivePage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`user-live:${message.text()}`); });
    await userLivePage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await userLivePage.locator("body").waitFor({ state: "visible" });
    await closeOptionalOverlays(userLivePage);
    await userLivePage.waitForTimeout(1_200);

    const adminContext = await createAuthenticatedContext(browser, adminToken, adminIdentity.user, report.viewport);
    adminContext.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.includes("__nextjs_original-stack-frames")) {
        report.failedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    const adminPage = await adminContext.newPage();
    adminPage.on("pageerror", (error) => report.pageErrors.push(`admin:${error.message}`));
    adminPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`admin:${message.text()}`); });
    const setAutomationFromUi = async (enabled) => {
      await adminPage.goto(`${origin}/admin?tab=benefit-packages`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await adminPage.getByTestId("member-package-template-manager").waitFor({ state: "visible", timeout: 30_000 });
      const toggle = adminPage.getByTestId("toggle-invited-registration-package");
      await toggle.waitFor({ state: "visible", timeout: 20_000 });
      const current = (await toggle.getAttribute("aria-checked")) === "true";
      if (current !== enabled) {
        adminPage.once("dialog", async (confirmation) => confirmation.accept());
        await toggle.click();
        await adminPage.waitForFunction(
          (desired) => document.querySelector('[data-testid="toggle-invited-registration-package"]')?.getAttribute("aria-checked") === String(desired),
          enabled,
          { timeout: 30_000 },
        );
      }
      const readBack = await jsonRequest(`${origin}/api/admin/member-packages/automation`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(readBack.response.status, 200, `PACKAGE_AUTOMATION_UI_READBACK_FAILED:${JSON.stringify(readBack.payload)}`);
      assert.equal(readBack.payload.automation?.enabled === true, enabled, "PACKAGE_AUTOMATION_UI_READBACK_MISMATCH");
      currentAutomationEnabled = enabled;
      return readBack.payload;
    };
    await adminPage.goto(`${origin}/admin?tab=invitations&member=${encodeURIComponent(inviter.id)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await adminPage.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(adminPage);
    let assignedRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: demo.assignedInvitee.displayName });
    await assignedRow.waitFor({ state: "visible", timeout: 30_000 });

    if (priorAssignment.rowCount === 0) {
      await assignedRow.getByTestId("open-member-package").click();
      const packageDialog = adminPage.getByRole("dialog", { name: /给 .*配置会员套餐/u });
      await packageDialog.waitFor({ state: "visible", timeout: 20_000 });
      await closeOptionalOverlays(adminPage);
      await adminPage.waitForTimeout(1_000);
      await packageDialog.getByRole("button", { name: /超级\s*VIP/u }).click();
      assert.match(await packageDialog.innerText(), /新增导航或智能体分类会自动出现在这里，但默认不勾选/u);
      adminPage.once("dialog", async (confirmation) => confirmation.accept());
      await packageDialog.getByTestId("member-package-assign").click();
      await packageDialog.waitFor({ state: "hidden", timeout: 30_000 });
      assignedRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: demo.assignedInvitee.displayName });
      await assignedRow.getByRole("button", { name: "查看新人套餐回执" }).waitFor({ state: "visible", timeout: 30_000 });
      report.assertions.superVipAssignedFromRealAdminUi = true;
    } else {
      assert.match(priorAssignment.rows[0].package_name, /超级.*VIP/iu, "EXISTING_DEMO_ASSIGNMENT_MUST_BE_SUPER_VIP");
      report.assertions.superVipAssignedFromRealAdminUi = "already-verified-retained-receipt";
    }

    const queueProbe = await client.query(
      `INSERT INTO public.user_notifications(user_id,type,title,content,cami_code,is_read,created_at,read_at,metadata)
       SELECT notice.user_id,notice.type,notice.title,notice.content,notice.cami_code,false,clock_timestamp(),NULL,
              (coalesce(notice.metadata,'{}'::jsonb) - 'dedupe_key')
              || jsonb_build_object(
                   'local_queue_probe',true,
                   'dedupe_key','local-queue-probe:' || gen_random_uuid()::text
                 )
         FROM public.member_package_assignments assignment
         JOIN public.user_notifications notice ON notice.id=assignment.notification_id
        WHERE assignment.invitation_record_id=$1
        ORDER BY assignment.created_at DESC LIMIT 1
       RETURNING id::text`,
      [relation.id],
    );
    assert.equal(queueProbe.rowCount, 1, "ACCOUNT_TOAST_QUEUE_PROBE_REQUIRED");
    notificationQueueProbeId = queueProbe.rows[0].id;
    await userLivePage.evaluate(() => window.dispatchEvent(new Event("refresh-account-notifications")));
    await userLivePage.waitForTimeout(750);
    const liveToast = userLivePage.getByTestId("account-notification-toast");
    const activeAnnouncement = userLivePage.getByTestId("announcement-reader");
    if (await activeAnnouncement.isVisible().catch(() => false)) {
      assert.equal(await liveToast.isVisible().catch(() => false), false, "ACCOUNT_TOAST_MUST_WAIT_BEHIND_ACTIVE_DIALOG");
      const closeAnnouncement = activeAnnouncement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
      if (await closeAnnouncement.count()) await closeAnnouncement.click();
    }
    await liveToast.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await activeAnnouncement.isVisible().catch(() => false), false, "ACCOUNT_TOAST_AND_ANNOUNCEMENT_MUST_NOT_OVERLAP");
    assert.match(await liveToast.innerText(), /超级.*VIP.*已开通/iu);
    const toastShot = path.join(evidenceDir, "01-user-live-bottom-right-toast-1440x900.png");
    await userLivePage.screenshot({ path: toastShot, fullPage: true });
    report.assertions.activeUserReceivesBottomRightToast = true;
    report.assertions.notificationSurfacesRespectSingleQueue = true;
    report.screenshots.push(toastShot);
    await client.query("DELETE FROM public.user_notifications WHERE id=$1::uuid AND metadata->>'local_queue_probe'='true'", [notificationQueueProbeId]);
    notificationQueueProbeId = null;
    await userLiveContext.close();

    const assignmentState = await client.query(
      `SELECT assignment.id::text,assignment.package_name,assignment.membership_status,
              assignment.credits,assignment.cash_amount,assignment.feature_navigation_keys,
              assignment.agent_navigation_keys,assignment.permission_revision,
              assignment.notification_id::text,account.member_status,account.credits AS user_credits,
              account.cash_balance AS user_cash,
              grant_row.status AS welcome_status,grant_row.recipient_user_id::text AS welcome_recipient,
              grant_row.package_assignment_id::text,
              relation.reward_sent,
              (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=account.id AND metadata->>'source'='member_package') AS package_wallet_ops,
              (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=account.id::uuid AND type='member_package') AS package_notifications
         FROM public.member_package_assignments assignment
         JOIN public.users account ON account.id=assignment.user_id
         JOIN public.invitation_records relation ON relation.id=assignment.invitation_record_id
         JOIN public.invitation_reward_grants grant_row
           ON grant_row.invitation_record_id=relation.id AND grant_row.reward_stage='invitee_welcome'
        WHERE assignment.invitation_record_id=$1
        ORDER BY assignment.created_at DESC LIMIT 1`,
      [relation.id],
    );
    assert.equal(assignmentState.rowCount, 1, "PACKAGE_ASSIGNMENT_RECEIPT_REQUIRED");
    const assignment = assignmentState.rows[0];
    assert.match(assignment.package_name, /超级.*VIP/iu);
    assert.equal(assignment.membership_status, "active");
    assert.equal(asNumber(assignment.credits), asNumber(superVipTemplate.credits));
    assert.equal(asNumber(assignment.cash_amount), asNumber(superVipTemplate.cashAmount));
    assert.equal(assignment.member_status, "active");
    assert.equal(asNumber(assignment.user_credits), asNumber(superVipTemplate.credits));
    assert.equal(asNumber(assignment.user_cash), asNumber(superVipTemplate.cashAmount));
    assert.equal(assignment.welcome_status, "sent");
    assert.equal(assignment.welcome_recipient, assignedInvitee.id);
    assert.equal(assignment.package_assignment_id, assignment.id);
    assert.equal(assignment.reward_sent, true);
    const expectedPackageWalletOps = (asNumber(superVipTemplate.credits) > 0 ? 1 : 0)
      + (asNumber(superVipTemplate.cashAmount) > 0 ? 1 : 0);
    assert.equal(asNumber(assignment.package_wallet_ops), expectedPackageWalletOps);
    assert.equal(asNumber(assignment.package_notifications), 1);
    assert.deepEqual([...assignment.feature_navigation_keys].sort(), [...superVipTemplate.featureNavigationKeys].sort());
    assert.deepEqual([...assignment.agent_navigation_keys].sort(), [...superVipTemplate.agentNavigationKeys].sort());
    const inviterPackageWallet = await client.query(
      `SELECT count(*)::integer AS count
         FROM public.wallet_operations
        WHERE user_id=$1 AND metadata->>'assignment_id'=$2`,
      [inviter.id, assignment.id],
    );
    assert.equal(asNumber(inviterPackageWallet.rows[0].count), 0, "NEWCOMER_PACKAGE_MUST_NOT_CREDIT_INVITER");
    report.assertions.packageReceiptWalletPermissionAndRecipientsAreAtomic = true;

    await assignedRow.getByRole("button", { name: "查看新人套餐回执" }).click();
    const receiptDialog = adminPage.getByRole("dialog", { name: /给 .*配置会员套餐/u });
    await receiptDialog.getByTestId("member-package-receipt").waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await receiptDialog.innerText(), /超级.*VIP/iu);
    assert.match(await receiptDialog.innerText(), new RegExp(`${asNumber(superVipTemplate.credits).toLocaleString("en-US")} 积分`, "u"));
    const receiptShot = path.join(evidenceDir, "02-admin-package-receipt-1440x900.png");
    await adminPage.screenshot({ path: receiptShot, fullPage: true });
    report.screenshots.push(receiptShot);
    await receiptDialog.getByRole("button", { name: "关闭", exact: true }).click();

    if (priorAssignment.rowCount > 0 && priorAssignment.rows[0].notification_id) {
      await client.query(
        "UPDATE public.user_notifications SET is_read=false,read_at=NULL WHERE id=$1::uuid AND user_id=$2::uuid",
        [priorAssignment.rows[0].notification_id, assignedInvitee.id],
      );
    }
    const userLoginContext = await createAuthenticatedContext(browser, inviteeLogin.token, inviteeLogin.user, report.viewport);
    const userLoginPage = await userLoginContext.newPage();
    userLoginPage.on("pageerror", (error) => report.pageErrors.push(`user-login:${error.message}`));
    userLoginPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`user-login:${message.text()}`); });
    await userLoginPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const loginDialog = userLoginPage.getByTestId("account-notification-dialog");
    const loginMessage = loginDialog.getByText(/超级.*VIP.*已开通/iu).first();
    for (let attempt = 0; attempt < 6 && !await loginMessage.isVisible().catch(() => false); attempt += 1) {
      const announcement = userLoginPage.getByTestId("announcement-reader");
      if (await announcement.isVisible().catch(() => false)) {
        const closeAnnouncement = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
        if (await closeAnnouncement.count()) await closeAnnouncement.click();
      }
      await userLoginPage.waitForTimeout(500);
    }
    await loginMessage.waitFor({ state: "visible", timeout: 20_000 });
    const loginShot = path.join(evidenceDir, "03-user-login-unread-dialog-1440x900.png");
    await userLoginPage.screenshot({ path: loginShot, fullPage: true });
    report.screenshots.push(loginShot);
    await loginDialog.getByRole("button", { name: "关闭账号消息" }).click();
    await userLoginPage.goto(`${origin}/profile?tab=notifications`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await userLoginPage.getByText(/超级.*VIP.*已开通/iu).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await userLoginPage.getByRole("button", { name: "一键兑换" }).count(), 0, "PACKAGE_MUST_NOT_REQUIRE_CLAIM");
    const centerShot = path.join(evidenceDir, "04-user-personal-center-receipt-1440x900.png");
    await userLoginPage.screenshot({ path: centerShot, fullPage: true });
    report.screenshots.push(centerShot);
    report.assertions.offlineLoginDialogAndPersonalCenterReceipt = true;
    await userLoginContext.close();

    const retiredSelfActivation = await jsonRequest(`${origin}/api/trial-plans/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${inviteeLogin.token}` },
      body: JSON.stringify({ planId: "legacy-self-service" }),
    });
    assert.equal(retiredSelfActivation.response.status, 410);
    assert.equal(retiredSelfActivation.payload.code, "TRIAL_SELF_ACTIVATION_RETIRED");
    report.assertions.userCannotBypassAdminWithLegacyTrialApi = true;

    const inviterLogin = await login(demo.inviter.phone, demo.inviter.password);

    // The only automation control is exercised from the real administration
    // page.  While enabled, an invited registration receives exactly the
    // current trial_member template; paid tiers and inviter rewards stay open
    // for an administrator decision.
    const enabledAutomation = await setAutomationFromUi(true);
    const autoTemplate = enabledAutomation.automation;
    assert.equal(autoTemplate.profileKey, "trial_member");
    assert.ok(Number(autoTemplate.profileVersion) > 0);
    report.assertions.automationSwitchEnabledFromRealAdminUi = true;

    let automaticUser = { rowCount: 0, rows: [] };
    for (let candidateIndex = 0; candidateIndex < 8; candidateIndex += 1) {
      const candidate = automaticDemoProfile(candidateIndex);
      const candidateUser = await client.query(
        `SELECT account.id::text,account.member_status,account.credits,account.cash_balance,
                (SELECT count(*)::integer FROM public.invitation_records relation WHERE relation.invitee_id::text=account.id::text) AS relation_count,
                (SELECT count(*)::integer FROM public.member_package_assignments assignment WHERE assignment.user_id=account.id) AS package_count,
                (SELECT count(*)::integer FROM public.member_package_automation_runs run
                  JOIN public.invitation_records relation ON relation.id=run.invitation_record_id
                 WHERE relation.invitee_id::text=account.id::text) AS automation_count
           FROM public.users account WHERE account.phone=$1 LIMIT 1`,
        [candidate.phone],
      );
      const availableExisting = candidateUser.rowCount === 1
        && candidateUser.rows[0].member_status === "trial"
        && asNumber(candidateUser.rows[0].relation_count) === 1
        && asNumber(candidateUser.rows[0].package_count) === 1
        && asNumber(candidateUser.rows[0].automation_count) === 1;
      if (candidateUser.rowCount === 0 || availableExisting) {
        automaticProfile = candidate;
        automaticUser = candidateUser;
        break;
      }
    }
    assert.ok(automaticProfile, "AVAILABLE_AUTOMATIC_DEMO_PROFILE_REQUIRED");
    let automaticConsumedCode = "";
    let automaticWasCreated = false;
    if (automaticUser.rowCount === 0) {
      const codeResult = await jsonRequest(`${origin}/api/invitation/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${inviterLogin.token}` },
      });
      assert.equal(codeResult.response.status, 200, `AUTOMATIC_DEMO_CODE_FAILED:${JSON.stringify(codeResult.payload)}`);
      automaticConsumedCode = String(codeResult.payload.code?.code || "");
      assert.match(automaticConsumedCode, /^[A-Z2-9]{8}$/u);
      await registerInvitedDemoUser(
        client,
        automaticProfile,
        automaticConsumedCode,
        "本地邀请套餐链路演示：自动体验包账号",
      );
      automaticWasCreated = true;
      automaticUser = await client.query(
        "SELECT id::text,member_status,credits,cash_balance FROM public.users WHERE phone=$1 LIMIT 1",
        [automaticProfile.phone],
      );
    } else {
      const codeRead = await client.query(
        `SELECT invitation_code_snapshot AS code FROM public.invitation_records
          WHERE invitee_id=$1::uuid ORDER BY invited_at DESC LIMIT 1`,
        [automaticUser.rows[0].id],
      );
      automaticConsumedCode = String(codeRead.rows[0]?.code || "");
    }
    const automaticUserId = String(automaticUser.rows[0].id);
    assert.equal(automaticUser.rows[0].member_status, "trial");
    if (automaticWasCreated) {
      assert.equal(asNumber(automaticUser.rows[0].credits), asNumber(autoTemplate.credits));
      assert.equal(asNumber(automaticUser.rows[0].cash_balance), asNumber(autoTemplate.cashAmount));
    }

    const automaticRelation = await client.query(
      `SELECT relation.id::text,relation.invitation_code_snapshot,relation.invitee_activated,relation.reward_sent,
              assignment.id::text AS assignment_id,assignment.profile_key,assignment.profile_version,
              assignment.package_name,assignment.membership_status,assignment.credits,assignment.cash_amount,
              assignment.permission_revision,assignment.notification_id::text,
              run.status AS automation_status,run.package_assignment_id::text AS automation_assignment_id,
              (SELECT status FROM public.invitation_reward_grants WHERE invitation_record_id=relation.id AND reward_stage='registration') AS registration_reward_status,
              (SELECT status FROM public.invitation_reward_grants WHERE invitation_record_id=relation.id AND reward_stage='invitee_welcome') AS welcome_status,
              (SELECT status FROM public.invitation_reward_grants WHERE invitation_record_id=relation.id AND reward_stage='activation') AS activation_reward_status,
              (SELECT eligibility_at FROM public.invitation_reward_grants WHERE invitation_record_id=relation.id AND reward_stage='activation') AS activation_eligibility
         FROM public.invitation_records relation
         JOIN public.member_package_assignments assignment ON assignment.invitation_record_id=relation.id
         JOIN public.member_package_automation_runs run ON run.invitation_record_id=relation.id
        WHERE relation.inviter_id=$1::uuid AND relation.invitee_id=$2::uuid
        ORDER BY relation.invited_at DESC LIMIT 1`,
      [inviter.id, automaticUserId],
    );
    assert.equal(automaticRelation.rowCount, 1, "AUTOMATIC_PACKAGE_RECEIPT_REQUIRED");
    const automaticReceipt = automaticRelation.rows[0];
    assert.equal(automaticReceipt.profile_key, "trial_member");
    if (automaticWasCreated) {
      assert.equal(asNumber(automaticReceipt.profile_version), asNumber(autoTemplate.profileVersion));
      assert.equal(automaticReceipt.package_name, autoTemplate.packageName);
      assert.equal(asNumber(automaticReceipt.credits), asNumber(autoTemplate.credits));
      assert.equal(asNumber(automaticReceipt.cash_amount), asNumber(autoTemplate.cashAmount));
    }
    assert.equal(automaticReceipt.membership_status, "trial");
    assert.ok(asNumber(automaticReceipt.profile_version) > 0);
    assert.equal(automaticReceipt.automation_status, "sent");
    assert.equal(automaticReceipt.automation_assignment_id, automaticReceipt.assignment_id);
    assert.equal(automaticReceipt.welcome_status, "sent");
    if (automaticWasCreated) assert.equal(automaticReceipt.registration_reward_status, "pending");
    else assert.ok(["pending", "draft", "sent", "skipped"].includes(automaticReceipt.registration_reward_status));
    assert.equal(automaticReceipt.activation_reward_status, "pending");
    assert.equal(automaticReceipt.activation_eligibility, null);
    if (automaticWasCreated) assert.equal(automaticReceipt.reward_sent, false);
    assert.equal(automaticReceipt.invitee_activated, false);
    assert.ok(asNumber(automaticReceipt.permission_revision) >= 2);
    const inviterAutomationWallet = await client.query(
      `SELECT count(*)::integer AS count
         FROM public.wallet_operations
        WHERE user_id=$1 AND metadata->>'assignment_id'=$2`,
      [inviter.id, automaticReceipt.assignment_id],
    );
    assert.equal(asNumber(inviterAutomationWallet.rows[0].count), 0, "AUTOMATIC_NEWCOMER_PACKAGE_MUST_NOT_REWARD_INVITER");
    report.assertions.enabledSwitchAtomicallyDeliversOnlyTrialPackage = true;
    report.assertions.automaticPackageDoesNotAutoSendInviterRewards = true;

    const automaticLogin = await login(automaticProfile.phone, automaticProfile.password);
    if (!automaticWasCreated && automaticReceipt.notification_id) {
      await client.query(
        "UPDATE public.user_notifications SET is_read=false,read_at=NULL WHERE id=$1::uuid AND user_id=$2::uuid",
        [automaticReceipt.notification_id, automaticUserId],
      );
    }
    const automaticContext = await createAuthenticatedContext(browser, automaticLogin.token, automaticLogin.user, report.viewport);
    const automaticPage = await automaticContext.newPage();
    automaticPage.on("pageerror", (error) => report.pageErrors.push(`automatic-user:${error.message}`));
    automaticPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(`automatic-user:${message.text()}`); });
    await automaticPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const automaticDialog = automaticPage.getByTestId("account-notification-dialog");
    const automaticPackageName = String(automaticReceipt.package_name || autoTemplate.packageName);
    const automaticMessage = automaticDialog.getByText(new RegExp(`${automaticPackageName}.*已开通`, "u")).first();
    for (let attempt = 0; attempt < 6 && !await automaticMessage.isVisible().catch(() => false); attempt += 1) {
      const announcement = automaticPage.getByTestId("announcement-reader");
      if (await announcement.isVisible().catch(() => false)) {
        const closeAnnouncement = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
        if (await closeAnnouncement.count()) await closeAnnouncement.click();
      }
      await automaticPage.waitForTimeout(500);
    }
    await automaticMessage.waitFor({ state: "visible", timeout: 20_000 });
    const automaticDialogShot = path.join(evidenceDir, "05-auto-trial-user-login-dialog-1440x900.png");
    await automaticPage.screenshot({ path: automaticDialogShot, fullPage: true });
    report.screenshots.push(automaticDialogShot);
    await automaticDialog.getByRole("button", { name: "关闭账号消息" }).click();
    await automaticPage.goto(`${origin}/profile?tab=notifications`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await automaticPage.getByText(new RegExp(`${automaticPackageName}.*已开通`, "u")).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await automaticPage.getByRole("button", { name: "一键兑换" }).count(), 0);
    const automaticCenterShot = path.join(evidenceDir, "06-auto-trial-user-personal-center-1440x900.png");
    await automaticPage.screenshot({ path: automaticCenterShot, fullPage: true });
    report.screenshots.push(automaticCenterShot);
    await automaticContext.close();
    report.assertions.automaticTrialPackageNotificationAndPersonalCenter = true;

    await setAutomationFromUi(false);
    report.assertions.automationSwitchDisabledFromRealAdminUi = true;

    let pendingUser = { rowCount: 0, rows: [] };
    for (let candidateIndex = 0; candidateIndex < 20; candidateIndex += 1) {
      const candidate = pendingDemoProfile(candidateIndex);
      const candidateUser = await client.query(
        `SELECT account.id::text,account.member_status,account.credits,account.cash_balance,
                (SELECT count(*)::integer FROM public.member_package_assignments assignment WHERE assignment.user_id=account.id::text) AS package_count,
                (SELECT count(*)::integer FROM public.invitation_records relation WHERE relation.invitee_id::text=account.id::text) AS relation_count
           FROM public.users account
          WHERE account.phone=$1
          LIMIT 1`,
        [candidate.phone],
      );
      const availableExisting = candidateUser.rowCount === 1
        && candidateUser.rows[0].member_status === "inactive"
        && asNumber(candidateUser.rows[0].credits) === 0
        && asNumber(candidateUser.rows[0].cash_balance) === 0
        && asNumber(candidateUser.rows[0].package_count) === 0
        && asNumber(candidateUser.rows[0].relation_count) === 1;
      if (candidateUser.rowCount === 0 || availableExisting) {
        pendingProfile = candidate;
        pendingUser = candidateUser;
        break;
      }
    }
    assert.ok(pendingProfile, "AVAILABLE_PENDING_DEMO_PROFILE_REQUIRED");
    let consumedCode = "";
    if (pendingUser.rowCount === 0) {
      const codeResult = await jsonRequest(`${origin}/api/invitation/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${inviterLogin.token}` },
      });
      assert.equal(codeResult.response.status, 200, `PENDING_DEMO_CODE_FAILED:${JSON.stringify(codeResult.payload)}`);
      consumedCode = String(codeResult.payload.code?.code || "");
      assert.match(consumedCode, /^[A-Z2-9]{8}$/u);
      await registerInvitedDemoUser(
        client,
        pendingProfile,
        consumedCode,
        "本地邀请套餐链路演示：保留待派发账号",
      );
      pendingUser = await client.query(
        "SELECT id::text,member_status,credits,cash_balance FROM public.users WHERE phone=$1 LIMIT 1",
        [pendingProfile.phone],
      );
      report.assertions.pendingDemoRegisteredWithSingleUseCode = true;
    } else {
      const codeRead = await client.query(
        `SELECT invitation_code_snapshot AS code FROM public.invitation_records
          WHERE invitee_id=$1::uuid ORDER BY invited_at DESC LIMIT 1`,
        [pendingUser.rows[0].id],
      );
      consumedCode = String(codeRead.rows[0]?.code || "");
      report.assertions.pendingDemoRegisteredWithSingleUseCode = "already-retained";
    }
    const pendingUserId = String(pendingUser.rows[0].id);
    assert.equal(pendingUser.rows[0].member_status, "inactive");
    assert.equal(asNumber(pendingUser.rows[0].credits), 0);
    assert.equal(asNumber(pendingUser.rows[0].cash_balance), 0);

    const pendingRelation = await client.query(
      `SELECT relation.id,relation.invitee_activated,relation.reward_sent,
              count(grant_row.id)::integer AS grant_count,
              count(*) FILTER (WHERE grant_row.status='pending')::integer AS pending_count,
              count(*) FILTER (WHERE grant_row.reward_stage='activation' AND grant_row.eligibility_at IS NULL)::integer AS locked_activation_count,
              count(package.id)::integer AS package_count
         FROM public.invitation_records relation
         JOIN public.invitation_reward_grants grant_row ON grant_row.invitation_record_id=relation.id
         LEFT JOIN public.member_package_assignments package ON package.invitation_record_id=relation.id
        WHERE relation.inviter_id=$1::uuid AND relation.invitee_id=$2::uuid
        GROUP BY relation.id`,
      [inviter.id, pendingUserId],
    );
    assert.equal(pendingRelation.rowCount, 1);
    assert.equal(pendingRelation.rows[0].invitee_activated, false);
    assert.equal(asNumber(pendingRelation.rows[0].grant_count), 3);
    assert.equal(asNumber(pendingRelation.rows[0].pending_count), 3);
    assert.equal(asNumber(pendingRelation.rows[0].locked_activation_count), 1);
    assert.equal(asNumber(pendingRelation.rows[0].package_count), 0);
    const pendingAutomationRun = await client.query(
      "SELECT count(*)::integer AS count FROM public.member_package_automation_runs WHERE invitation_record_id=$1",
      [pendingRelation.rows[0].id],
    );
    assert.equal(asNumber(pendingAutomationRun.rows[0].count), 0, "DISABLED_SWITCH_MUST_NOT_ATTEMPT_PACKAGE");
    report.assertions.disabledSwitchLeavesNewcomerPending = true;

    const nextCodeResult = await jsonRequest(`${origin}/api/invitation/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviterLogin.token}` },
    });
    assert.equal(nextCodeResult.response.status, 200);
    const nextOpenCode = String(nextCodeResult.payload.code?.code || "");
    assert.match(nextOpenCode, /^[A-Z2-9]{8}$/u);
    assert.notEqual(nextOpenCode, consumedCode, "NEXT_MEMBER_REQUIRES_NEW_CODE");
    assert.notEqual(consumedCode, automaticConsumedCode, "AUTOMATIC_AND_PENDING_MEMBERS_REQUIRE_SEPARATE_CODES");
    report.assertions.secondInvitationHasFreshOpenCode = true;

    await adminPage.goto(`${origin}/admin?tab=invitations&member=${encodeURIComponent(inviter.id)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await adminPage.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(adminPage);
    const pendingRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: pendingProfile.displayName });
    await pendingRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await pendingRow.innerText(), /给新人选套餐/u);
    assert.match(await pendingRow.innerText(), /发给邀请人/u);
    assert.match(await pendingRow.innerText(), /等待会员激活/u);
    const pendingShot = path.join(evidenceDir, "05-admin-retained-pending-dispatch-1440x900.png");
    await adminPage.screenshot({ path: pendingShot, fullPage: true });
    report.screenshots.push(pendingShot);
    report.assertions.pendingDemoShowsAllThreeAdminActions = true;

    await pendingRow.getByRole("button", { name: "发给邀请人", exact: true }).first().click();
    const rewardDialog = adminPage.getByTestId("invitation-reward-dialog");
    await rewardDialog.waitFor({ state: "visible", timeout: 20_000 });
    const rewardCredits = rewardDialog.getByTestId("invitation-reward-credits");
    const rewardCash = rewardDialog.getByTestId("invitation-reward-cash");
    await rewardCredits.fill("123");
    await rewardCash.fill("4.56");
    await rewardDialog.getByTestId("invitation-reward-template-thanks").click();
    const rewardPreview = rewardDialog.getByTestId("invitation-reward-message-preview");
    await rewardPreview.getByText(/123 积分/u).waitFor({ state: "visible", timeout: 10_000 });
    await rewardPreview.getByText(/¥4\.56/u).waitFor({ state: "visible", timeout: 10_000 });
    const editableMessage = "感谢你邀请新学员加入，123 积分和 ¥4.56 现金已到账。";
    await rewardDialog.getByTestId("invitation-reward-message-template").fill("感谢你邀请新学员加入，{{积分}} 积分和 ¥{{现金}} 现金已到账。");
    assert.match(await rewardPreview.innerText(), new RegExp(editableMessage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(await rewardDialog.getByTestId("invitation-reward-send").isEnabled(), true);
    const rewardTemplateShot = path.join(evidenceDir, "05b-admin-invitation-reward-template-preview-1440x900.png");
    await adminPage.screenshot({ path: rewardTemplateShot, fullPage: true });
    report.screenshots.push(rewardTemplateShot);
    await rewardDialog.getByRole("button", { name: "关闭礼包派发窗口" }).click();
    await rewardDialog.waitFor({ state: "hidden", timeout: 10_000 });
    report.assertions.invitationRewardTemplatesRenderLiveAmountsAndRemainEditable = true;

    await adminPage.goto(`${origin}/admin?tab=benefit-packages`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const packageManager = adminPage.getByTestId("member-package-template-manager");
    await packageManager.waitFor({ state: "visible", timeout: 30_000 });
    for (const label of ["trial_member", "formal_member", "super_vip"].map((key) => catalog.payload.templates.find((item) => item.key === key)?.name).filter(Boolean)) {
      await adminPage.getByText(label, { exact: true }).first().waitFor({ state: "visible" });
    }
    const beforeCustom = await jsonRequest(`${origin}/api/admin/member-packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(beforeCustom.response.status, 200);
    let customTemplate = beforeCustom.payload.templates.find((item) => item.name === demo.customBenefit.name);
    if (!customTemplate) {
      await packageManager.getByTestId("create-member-package-template").click();
      await packageManager.getByLabel("套餐名称").fill(demo.customBenefit.name);
      await packageManager.getByLabel("套餐说明").fill(demo.customBenefit.description);
      await packageManager.getByLabel("有效天数").fill(String(demo.customBenefit.durationDays));
      await packageManager.getByLabel("赠送积分").fill(String(demo.customBenefit.credits));
      await packageManager.getByLabel("赠送现金（元）").fill(String(demo.customBenefit.cashAmount));
      await packageManager.getByRole("button", { name: "应用广场 /", exact: true }).click();
      adminPage.once("dialog", (dialog) => void dialog.accept());
      const saveResponsePromise = adminPage.waitForResponse((response) => response.url().endsWith("/api/admin/member-packages") && response.request().method() === "PUT", { timeout: 30_000 });
      await packageManager.getByTestId("save-member-package-template").click();
      const saveResponse = await saveResponsePromise;
      assert.equal(saveResponse.status(), 200, "CUSTOM_BENEFIT_TEMPLATE_SAVE_FAILED");
      await packageManager.getByText(demo.customBenefit.name, { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    }
    const afterCustom = await jsonRequest(`${origin}/api/admin/member-packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(afterCustom.response.status, 200);
    customTemplate = afterCustom.payload.templates.find((item) => item.name === demo.customBenefit.name);
    assert.ok(customTemplate, "CUSTOM_BENEFIT_TEMPLATE_MISSING");
    assert.equal(asNumber(customTemplate.durationDays), demo.customBenefit.durationDays);
    assert.equal(asNumber(customTemplate.credits), demo.customBenefit.credits);
    assert.equal(asNumber(customTemplate.cashAmount), demo.customBenefit.cashAmount);
    assert.ok(customTemplate.featureNavigationKeys.includes("marketplace"));
    report.assertions.customBenefitTemplateCanBeCreatedManually = true;
    const templateText = await packageManager.innerText();
    assert.match(templateText, /新增能力默认关闭/u);
    assert.match(templateText, /旧会员不受影响/u);
    assert.match(templateText, /不发起支付/u);
    const templateShot = path.join(evidenceDir, "06-admin-package-template-manager-1440x900.png");
    await adminPage.screenshot({ path: templateShot, fullPage: true });
    report.screenshots.push(templateShot);

    await adminPage.goto(`${origin}/admin?tab=trial-plans`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const trialSeparation = adminPage.getByTestId("trial-plan-separation-note");
    await trialSeparation.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await trialSeparation.innerText(), /试用套餐目录与邀请礼包分开管理/u);
    assert.match(await trialSeparation.innerText(), /不会自动派发邀请码礼包/u);
    const trialCatalogRead = await jsonRequest(`${origin}/api/admin/trial-plans`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(trialCatalogRead.response.status, 200, `TRIAL_CATALOG_READ_FAILED:${JSON.stringify(trialCatalogRead.payload)}`);
    await adminPage.getByRole("button", { name: "+ 新增套餐", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const trialLayout = await adminPage.evaluate(() => ({
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(trialLayout.horizontalOverflow <= 1, `TRIAL_PLAN_HORIZONTAL_OVERFLOW:${trialLayout.horizontalOverflow}`);
    assert.equal(trialLayout.applicationError, false);
    const trialShot = path.join(evidenceDir, "08-admin-trial-plan-separated-1440x900.png");
    await adminPage.screenshot({ path: trialShot, fullPage: true });
    report.screenshots.push(trialShot);
    report.assertions.trialCatalogSeparatedFromInvitationBenefitsAndPayment = true;

    await adminPage.goto(`${origin}/admin?tab=users&member=${encodeURIComponent(pendingUserId)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await adminPage.getByTestId("admin-member-card").filter({ hasText: pendingProfile.displayName }).waitFor({ state: "visible", timeout: 30_000 });
    const pendingCard = adminPage.getByTestId("admin-member-card").filter({ hasText: pendingProfile.displayName });
    await pendingCard.getByTestId("open-member-package-from-user").click();
    const memberPackageDialog = adminPage.getByRole("dialog", { name: /给 .*配置会员套餐/u });
    await memberPackageDialog.waitFor({ state: "visible", timeout: 20_000 });
    await memberPackageDialog.getByRole("button", { name: /体验包/u }).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await memberPackageDialog.innerText(), /体验包/u);
    assert.match(await memberPackageDialog.innerText(), /正式会员/u);
    assert.ok((await memberPackageDialog.innerText()).includes(superVipTemplate.name));
    const memberShot = path.join(evidenceDir, "07-admin-member-direct-package-entry-1440x900.png");
    await adminPage.screenshot({ path: memberShot, fullPage: true });
    report.screenshots.push(memberShot);
    await memberPackageDialog.getByRole("button", { name: "取消" }).click();
    report.assertions.memberManagementHasDirectPackageEntry = true;

    for (const [tab, expected] of [["cami", "卡密管理"], ["login-logs", "登录日志"]]) {
      await adminPage.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await adminPage.locator("main").waitFor({ state: "visible", timeout: 30_000 });
      await closeOptionalOverlays(adminPage);
      assert.match(await adminPage.locator("main").innerText(), new RegExp(expected, "u"));
      const layout = await adminPage.evaluate(() => ({
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      }));
      assert.ok(layout.horizontalOverflow <= 1, `ADJACENT_HORIZONTAL_OVERFLOW:${tab}:${layout.horizontalOverflow}`);
      assert.equal(layout.applicationError, false, `ADJACENT_APPLICATION_ERROR:${tab}`);
    }
    report.assertions.twoAdjacentMemberPagesPassed = true;

    const adminLayout = await adminPage.evaluate(() => ({
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(adminLayout.horizontalOverflow <= 1);
    assert.equal(adminLayout.applicationError, false);
    await adminContext.close();

    report.demo = {
      inviter: { id: inviter.id, phone: demo.inviter.phone, displayName: demo.inviter.displayName },
      assignedInvitee: { id: assignedInvitee.id, phone: demo.assignedInvitee.phone, displayName: demo.assignedInvitee.displayName, package: assignment.package_name },
      automaticInvitee: {
        id: automaticUserId,
        phone: automaticProfile.phone,
        displayName: automaticProfile.displayName,
        password: automaticProfile.password,
        package: automaticReceipt.package_name,
      },
      pendingInvitee: { id: pendingUserId, phone: pendingProfile.phone, displayName: pendingProfile.displayName, password: pendingProfile.password },
      automaticConsumedCode,
      consumedCode,
      nextOpenCode,
      customBenefit: { name: demo.customBenefit.name, credits: demo.customBenefit.credits, cashAmount: demo.customBenefit.cashAmount },
      inspectAdmin: `${origin}/admin?tab=invitations&member=${inviter.id}`,
      inspectPackageTemplates: `${origin}/admin?tab=benefit-packages`,
      retained: true,
    };
    report.passed = true;
    report.checkedAt = new Date().toISOString();
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.failedResponses, []);

    await fs.writeFile(path.join(evidenceDir, "demo.local.json"), `${JSON.stringify({
      localOnly: true,
      origin,
      inviter: demo.inviter,
      assignedInvitee: demo.assignedInvitee,
      automaticInvitee: automaticProfile,
      pendingInvitee: pendingProfile,
      customBenefit: demo.customBenefit,
      automaticConsumedCode,
      consumedCode,
      nextOpenCode,
      inspectAdmin: report.demo.inspectAdmin,
      inspectPackageTemplates: report.demo.inspectPackageTemplates,
    }, null, 2)}\n`, "utf8");
  } finally {
    if (notificationQueueProbeId) {
      await client.query("DELETE FROM public.user_notifications WHERE id=$1::uuid AND metadata->>'local_queue_probe'='true'", [notificationQueueProbeId]).catch(() => undefined);
    }
    if (originalAutomationEnabled !== null && currentAutomationEnabled !== originalAutomationEnabled) {
      const restored = await client.query(
        "SELECT public.set_invited_registration_package_automation_atomic($1,$2,$3) AS result",
        [adminId, originalAutomationEnabled, `e2e-restore-invited-registration:${crypto.randomUUID()}`],
      ).catch(() => null);
      if (restored?.rows[0]?.result?.success === true) currentAutomationEnabled = originalAutomationEnabled;
    }
    if (browser) await browser.close().catch(() => undefined);
    await client.end();
  }

  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
