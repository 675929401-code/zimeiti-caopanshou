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
const evidenceDir = path.resolve(".codex-evidence", "invitation-pending-ledger", "live");

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function closeOptionalOverlays(page) {
  await page.waitForTimeout(500);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const announcement = page.getByTestId("announcement-reader");
    if (await announcement.isVisible().catch(() => false)) {
      const close = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
      if (await close.count()) await close.click();
      continue;
    }
    const account = page.getByTestId("account-notification-dialog");
    if (await account.isVisible().catch(() => false)) {
      const close = account.getByRole("button", { name: /关闭账号消息|稍后查看|关闭|知道了/u }).first();
      if (await close.count()) await close.click();
      continue;
    }
    break;
  }
}

async function setAutomation(enabled, suffix) {
  const requestKey = `pending-ledger-e2e:${suffix}:${crypto.randomUUID()}`;
  const result = await jsonRequest(`${origin}/api/admin/member-packages/automation`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify({ enabled, idempotencyKey: requestKey }),
  });
  assert.equal(result.response.status, 200, `AUTOMATION_TOGGLE_FAILED:${JSON.stringify(result.payload)}`);
}

function number(value) {
  const result = Number(value);
  assert.ok(Number.isFinite(result), `FINITE_NUMBER_REQUIRED:${value}`);
  return result;
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

  const runId = crypto.randomUUID();
  const shortId = runId.slice(0, 8);
  const inviterId = crypto.randomUUID();
  const codeId = crypto.randomUUID();
  const code = runId.replaceAll("-", "").slice(0, 8).toUpperCase();
  const inviterName = `待处理状态验收-邀请人-${shortId}`;
  const inviteeName = `待处理状态验收-新人-${shortId}`;
  const inviteePhone = `19${Date.now().toString().slice(-9)}`;
  const inviteeEmail = `pending-ledger-${shortId}@local.test`;
  const inviteeUsername = `pending_ledger_${shortId}`;
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-invitation-pending-ledger-e2e",
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });

  const report = {
    passed: false,
    checkedAt: "",
    target: `${origin}/admin?tab=invitations`,
    viewport: { width: 1440, height: 900 },
    fixture: { inviterName, inviteeName },
    assertions: {},
    screenshots: [],
    adjacentPages: [],
    failedResponses: [],
    pageErrors: [],
    consoleErrors: [],
    fixtureResidue: null,
    productionWrites: 0,
    paidCalls: 0,
  };

  let browser;
  let inviteeId = "";
  let recordId = "";
  let originalAutomationEnabled = false;
  let automationChanged = false;
  await fs.mkdir(evidenceDir, { recursive: true });
  await client.connect();
  try {
    const automation = await jsonRequest(`${origin}/api/admin/member-packages/automation`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(automation.response.status, 200, "AUTOMATION_READ_REQUIRED");
    originalAutomationEnabled = automation.payload.automation?.enabled === true;
    if (originalAutomationEnabled) {
      await setAutomation(false, "disable");
      automationChanged = true;
    }

    const inviterPassword = await bcrypt.hash(`Local-${runId}`, 10);
    await client.query(
      `INSERT INTO public.users
       (id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,allowed_categories,created_at,updated_at)
       VALUES($1,$2,$3,$4,'student',0,0,true,'active','active','[]'::jsonb,now(),now())`,
      [inviterId, `pending_inviter_${shortId}`, inviterPassword, inviterName],
    );
    await client.query(
      `INSERT INTO public.invitation_codes(id,user_id,code,is_used,is_permanent,created_at)
       VALUES($1,$2,$3,false,false,now())`,
      [codeId, inviterId, code],
    );

    const inviteePassword = await bcrypt.hash(`Invitee-${runId}`, 10);
    const registration = await client.query(
      "SELECT public.register_invited_user_atomic($1,$2,$3,$4,$5,$6,$7) AS result",
      [inviteeEmail, inviteePhone, inviteeUsername, inviteePassword, inviteeName, code, crypto.randomBytes(32).toString("hex")],
    );
    assert.equal(registration.rows[0]?.result?.ok, true, `INVITED_REGISTRATION_FAILED:${JSON.stringify(registration.rows[0]?.result)}`);
    inviteeId = String(registration.rows[0].result.user?.id || "");
    assert.match(inviteeId, /^[0-9a-f-]{36}$/iu, "INVITEE_ID_REQUIRED");
    const relation = await client.query(
      "SELECT id FROM public.invitation_records WHERE inviter_id=$1 AND invitee_id=$2 ORDER BY invited_at DESC LIMIT 1",
      [inviterId, inviteeId],
    );
    recordId = String(relation.rows[0]?.id || "");
    assert.ok(recordId, "INVITATION_RELATION_REQUIRED");
    const seeded = await client.query(
      `SELECT reward_stage,status,eligibility_at FROM public.invitation_reward_grants
       WHERE invitation_record_id=$1 ORDER BY reward_stage`,
      [recordId],
    );
    assert.equal(seeded.rowCount, 3, "THREE_WORKFLOW_NODES_REQUIRED");
    report.assertions.oneTimeRegistrationSeedsThreeWorkflowNodes = true;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block", acceptDownloads: true });
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.includes("__nextjs_original-stack-frames")) {
        report.failedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: adminToken, user: adminIdentity.user });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) report.consoleErrors.push(message.text());
    });

    await page.goto(`${origin}/admin?tab=invitations`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(page);
    await page.getByTestId("invitation-search").fill(inviteeName);
    await page.getByRole("button", { name: "待处理", exact: true }).click();
    let row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviteeName });
    await row.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await row.getByTestId("invitation-workflow-state").innerText(), /给新人选套餐.*发邀请注册奖励/u);
    const initialShot = path.join(evidenceDir, "01-registration-pending-1440x900.png");
    await page.screenshot({ path: initialShot, fullPage: true });
    report.screenshots.push(initialShot);

    await row.getByTestId("open-member-package").click();
    const packageDialog = page.getByRole("dialog", { name: new RegExp(`给 ${inviteeName} 配置会员套餐`, "u") });
    await packageDialog.waitFor({ state: "visible", timeout: 20_000 });
    await packageDialog.getByRole("button").filter({ hasText: /^体验包/u }).first().click();
    page.once("dialog", (dialog) => void dialog.accept());
    const packageResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/member-packages/assign") && response.request().method() === "POST", { timeout: 30_000 });
    await packageDialog.getByTestId("member-package-assign").click();
    assert.equal((await packageResponse).status(), 200, "PACKAGE_ASSIGNMENT_FAILED");
    await packageDialog.waitFor({ state: "hidden", timeout: 30_000 });
    row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviteeName });
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await row.getByText("套餐已开通", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await row.innerText(), /套餐已开通/u);
    assert.match(await row.getByTestId("invitation-workflow-state").innerText(), /^当前待处理：发邀请注册奖励/u);
    report.assertions.packageAssignmentClosesNewcomerStage = true;

    await row.getByRole("button", { name: "发给邀请人", exact: true }).first().click();
    let rewardDialog = page.getByTestId("invitation-reward-dialog");
    await rewardDialog.getByTestId("invitation-reward-credits").fill("17");
    await rewardDialog.getByTestId("invitation-reward-cash").fill("3.25");
    const rawTemplate = await rewardDialog.getByTestId("invitation-reward-message-template").inputValue();
    assert.match(rawTemplate, /\{\{积分\}\}/u);
    assert.match(rawTemplate, /\{\{现金\}\}/u);
    const variableMap = await rewardDialog.getByTestId("invitation-reward-variable-map").innerText();
    assert.match(variableMap, /17 积分/u);
    assert.match(variableMap, /¥3\.25 现金/u);
    const preview = await rewardDialog.getByTestId("invitation-reward-message-preview").innerText();
    assert.match(preview, /17 积分/u);
    assert.match(preview, /¥3\.25 现金/u);
    assert.doesNotMatch(preview, /\{\{/u);
    const variableShot = path.join(evidenceDir, "02-template-variables-resolved-1440x900.png");
    await page.screenshot({ path: variableShot, fullPage: true });
    report.screenshots.push(variableShot);
    page.once("dialog", (dialog) => void dialog.accept());
    const registrationRewardResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/invitations/rewards") && response.request().method() === "POST", { timeout: 30_000 });
    await rewardDialog.getByTestId("invitation-reward-send").click();
    assert.equal((await registrationRewardResponse).status(), 200, "REGISTRATION_REWARD_FAILED");
    await rewardDialog.waitFor({ state: "hidden", timeout: 30_000 });
    await row.waitFor({ state: "hidden", timeout: 20_000 });
    report.assertions.registrationStageLeavesPendingAfterBothActions = true;

    await page.getByRole("button", { name: "注册未激活", exact: true }).click();
    row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviteeName });
    await row.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await row.getByTestId("invitation-workflow-state").innerText(), /注册阶段已完成.*正式激活后会自动回到待处理/u);
    assert.match(await row.innerText(), /注册奖励已入账/u);
    report.assertions.inactiveQueueRetainsWaitingRelationWithoutPendingNoise = true;

    const activation = await client.query(
      "SELECT public.set_member_activation_state_atomic($1,$2,'active','admin_manual',$3,3980,$4,$5) AS result",
      [adminId, inviteeId, `pending-ledger-e2e-${runId}`, "待处理自动回队验收", `pending-ledger-activation:${runId}`],
    );
    assert.equal(activation.rows[0]?.result?.success, true, `ACTIVATION_FAILED:${JSON.stringify(activation.rows[0]?.result)}`);
    await page.getByRole("button", { name: "待处理", exact: true }).click();
    await page.getByRole("button", { name: "刷新真实数据", exact: true }).click();
    row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviteeName });
    await row.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await row.getByTestId("invitation-workflow-state").innerText(), /^当前待处理：发正式会员邀请奖励/u);
    assert.match(await row.innerText(), /待发正式奖励/u);
    report.assertions.formalActivationReturnsRelationToPending = true;

    await row.getByRole("button", { name: "发给邀请人", exact: true }).click();
    rewardDialog = page.getByTestId("invitation-reward-dialog");
    await rewardDialog.getByTestId("invitation-reward-credits").fill("29");
    await rewardDialog.getByTestId("invitation-reward-cash").fill("5.50");
    page.once("dialog", (dialog) => void dialog.accept());
    const activationRewardResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/invitations/rewards") && response.request().method() === "POST", { timeout: 30_000 });
    await rewardDialog.getByTestId("invitation-reward-send").click();
    assert.equal((await activationRewardResponse).status(), 200, "ACTIVATION_REWARD_FAILED");
    await rewardDialog.waitFor({ state: "hidden", timeout: 30_000 });
    await row.waitFor({ state: "hidden", timeout: 20_000 });

    await page.getByRole("button", { name: "已闭环", exact: true }).click();
    row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviteeName });
    await row.waitFor({ state: "visible", timeout: 20_000 });
    const closedText = await row.innerText();
    assert.match(closedText, /套餐已开通/u);
    assert.match(closedText, /注册奖励已入账/u);
    assert.match(closedText, /正式奖励已入账/u);
    assert.match(closedText, /已闭环.*自动移出待处理/u);
    report.assertions.formalRewardClosesAndRemovesPendingRelation = true;

    const wallet = await client.query(
      `SELECT account.credits,account.cash_balance,
              (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS operation_count,
              (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid AND type='invitation_reward') AS notification_count
       FROM public.users account WHERE account.id=$1`,
      [inviterId],
    );
    assert.equal(number(wallet.rows[0].credits), 46);
    assert.equal(number(wallet.rows[0].cash_balance), 8.75);
    assert.equal(number(wallet.rows[0].operation_count), 4);
    assert.equal(number(wallet.rows[0].notification_count), 2);
    report.assertions.twoRewardsReachWalletAndNotificationsExactlyOnce = true;

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByTestId("download-invitation-ledger").click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^邀请关系账单-\d{4}-\d{2}-\d{2}\.csv$/u);
    const downloadPath = await download.path();
    assert.ok(downloadPath, "CSV_DOWNLOAD_PATH_REQUIRED");
    const csv = await fs.readFile(downloadPath, "utf8");
    assert.equal(csv.charCodeAt(0), 0xFEFF, "CSV_UTF8_BOM_REQUIRED");
    for (const text of ["累计受邀注册用户数", "受邀正式会员数", "当前待处理关系数", "关系编号", inviteeName, "正式奖励状态"]) {
      assert.ok(csv.includes(text), `CSV_CONTENT_MISSING:${text}`);
    }
    report.assertions.fullInvitationLedgerDownloadsFromUi = true;

    const closedShot = path.join(evidenceDir, "03-completed-and-ledger-download-1440x900.png");
    await page.screenshot({ path: closedShot, fullPage: true });
    report.screenshots.push(closedShot);
    const targetLayout = await page.evaluate(() => ({
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(targetLayout.horizontalOverflow <= 1, `TARGET_HORIZONTAL_OVERFLOW:${targetLayout.horizontalOverflow}`);
    assert.equal(targetLayout.applicationError, false, "TARGET_APPLICATION_ERROR");
    report.assertions.targetDesktopLayoutPassed = true;

    for (const tab of ["users", "cami"]) {
      await page.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
      await closeOptionalOverlays(page);
      const layout = await page.evaluate(() => ({
        textLength: document.querySelector("main")?.textContent?.trim().length || 0,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      }));
      assert.ok(layout.textLength > 100, `ADJACENT_PAGE_EMPTY:${tab}`);
      assert.ok(layout.horizontalOverflow <= 1, `ADJACENT_HORIZONTAL_OVERFLOW:${tab}:${layout.horizontalOverflow}`);
      assert.equal(layout.applicationError, false, `ADJACENT_APPLICATION_ERROR:${tab}`);
      report.adjacentPages.push({ tab, ...layout });
      const shot = path.join(evidenceDir, `adjacent-${tab}-1440x900.png`);
      await page.screenshot({ path: shot, fullPage: true });
      report.screenshots.push(shot);
    }
    report.assertions.twoAdjacentAdminPagesPassed = true;
    report.passed = true;
    report.checkedAt = new Date().toISOString();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (automationChanged) await setAutomation(originalAutomationEnabled, "restore").catch(() => undefined);
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("BEGIN");
    try {
      if (recordId) {
        await client.query("DELETE FROM public.member_package_automation_runs WHERE invitation_record_id=$1", [recordId]);
        await client.query("DELETE FROM public.member_package_assignments WHERE invitation_record_id=$1", [recordId]);
        await client.query("DELETE FROM public.invitation_records WHERE id=$1", [recordId]);
      }
      if (inviteeId) await client.query("DELETE FROM public.member_activation_events WHERE user_id=$1", [inviteeId]);
      await client.query("DELETE FROM public.user_notifications WHERE user_id::text=ANY($1::text[])", [[inviterId, inviteeId].filter(Boolean)]);
      await client.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=ANY($1::text[])", [[inviterId, inviteeId].filter(Boolean)]);
      await client.query("DELETE FROM public.wallet_operations WHERE user_id=ANY($1::text[])", [[inviterId, inviteeId].filter(Boolean)]);
      if (inviteeId) await client.query("DELETE FROM public.password_audit_log WHERE user_id=$1", [inviteeId]);
      await client.query("DELETE FROM public.invitation_codes WHERE id=$1", [codeId]);
      await client.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [[inviterId, inviteeId].filter(Boolean)]);
      await client.query("COMMIT");
    } catch (cleanupError) {
      await client.query("ROLLBACK");
      throw cleanupError;
    }
    const residue = await client.query(
      `SELECT
        (SELECT count(*)::integer FROM public.users WHERE id=ANY($1::text[])) AS users,
        (SELECT count(*)::integer FROM public.invitation_codes WHERE id=$2) AS codes,
        (SELECT count(*)::integer FROM public.invitation_records WHERE id=$3) AS relations,
        (SELECT count(*)::integer FROM public.member_package_assignments WHERE invitation_record_id=$3) AS packages,
        (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($1::text[])) AS wallet_operations,
        (SELECT count(*)::integer FROM public.user_notifications WHERE user_id::text=ANY($1::text[])) AS notifications`,
      [[inviterId, inviteeId].filter(Boolean), codeId, recordId || "missing"],
    );
    report.fixtureResidue = residue.rows[0];
    assert.deepEqual(Object.values(residue.rows[0]).map(Number), [0, 0, 0, 0, 0, 0], "FIXTURE_RESIDUE_DETECTED");
    await client.end();
  }

  assert.deepEqual(report.failedResponses, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
