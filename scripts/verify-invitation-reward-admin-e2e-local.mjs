#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence", "invitation-reward-closed-loop", "live");

function asNumber(value) {
  const result = Number(value);
  assert.ok(Number.isFinite(result), `FINITE_NUMBER_REQUIRED:${value}`);
  return result;
}

async function closeOptionalOverlays(page) {
  const announcement = page.getByTestId("announcement-reader");
  if (await announcement.isVisible().catch(() => false)) {
    const close = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
    if (await close.count()) await close.click();
  }
  const account = page.getByTestId("account-notification-dialog");
  if (await account.isVisible().catch(() => false)) {
    const close = account.getByRole("button", { name: /稍后查看|关闭|知道了/u }).first();
    if (await close.count()) await close.click();
  }
}

async function verifyPostCleanupPages({ origin, token, identity, evidenceDir, report }) {
  const browser = await chromium.launch({ headless: true });
  const blockedWrites = [];
  const suppressedDiagnostics = [];
  try {
    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const diagnostic = request.method() === "POST"
        && url.origin === origin
        && url.pathname === "/__nextjs_original-stack-frames";
      const operationDiagnostic = request.method() === "POST"
        && url.origin === origin
        && ["/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname);
      if (operationDiagnostic) {
        suppressedDiagnostics.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (!["GET", "HEAD"].includes(request.method()) && !diagnostic) {
        blockedWrites.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) report.consoleErrors.push(message.text());
    });

    for (const tab of ["invitations", "users", "cami"]) {
      await page.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
      await closeOptionalOverlays(page);
      if (tab === "invitations") {
        await page.getByTestId("invitation-workflow").waitFor({ state: "visible" });
        await page.getByTestId("invitation-empty-state").waitFor({ state: "visible" });
        assert.match(await page.getByTestId("invitation-empty-state").innerText(), /当前没有可处理的邀请关系/u);
      }
      const layout = await page.evaluate(() => ({
        textLength: document.querySelector("main")?.textContent?.trim().length || 0,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      }));
      assert.ok(layout.textLength > 80, `ADMIN_TAB_EMPTY:${tab}`);
      assert.ok(layout.horizontalOverflow <= 1, `ADMIN_TAB_HORIZONTAL_OVERFLOW:${tab}:${layout.horizontalOverflow}`);
      assert.equal(layout.applicationError, false, `ADMIN_TAB_APPLICATION_ERROR:${tab}`);
      report.adjacentPages.push({ tab, ...layout });
      await page.screenshot({ path: path.join(evidenceDir, `${tab}-post-cleanup-1440x900.png`), fullPage: true });
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(blockedWrites, [], `UNEXPECTED_READONLY_PAGE_WRITES:${blockedWrites.join(",")}`);
  report.operationFlightRecorderObserved = suppressedDiagnostics.some((entry) => entry === "POST /api/operation-events");
  report.assertions.emptyStateExplainsHowFirstRelationAppears = true;
  report.assertions.twoAdjacentAdminPagesPassed = true;
  report.readOnlyBlockedWrites = blockedWrites;
  report.suppressedDiagnostics = suppressedDiagnostics;
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const adminId = String(identity.user.id || "");
  assert.match(adminId, /^[0-9a-f-]{36}$/iu, "LOCAL_ADMIN_UUID_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const runId = crypto.randomUUID();
  const inviterId = crypto.randomUUID();
  const inviteeId = crypto.randomUUID();
  const codeId = crypto.randomUUID();
  const code = runId.replace(/-/gu, "").slice(0, 8).toUpperCase();
  const prefix = `z_invite_e2e_${runId.slice(0, 8)}`;
  const inviterName = `闭环验收邀请人-${runId.slice(0, 6)}`;
  const inviteeName = `闭环验收受邀人-${runId.slice(0, 6)}`;
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-invitation-reward-admin-e2e",
    connectionTimeoutMillis: 10_000,
    query_timeout: 45_000,
  });

  let browser;
  let recordId = "";
  const report = {
    passed: false,
    checkedAt: "",
    target: `${origin}/admin?tab=invitations`,
    viewport: { width: 1440, height: 900 },
    assertions: {},
    failedResponses: [],
    pageErrors: [],
    consoleErrors: [],
    fixtureResidue: null,
    adjacentPages: [],
    readOnlyBlockedWrites: [],
    suppressedDiagnostics: [],
    productionWrites: 0,
    paidCalls: 0,
  };

  await client.connect();
  try {
    const abandonedFixtureRows = await client.query(
      "SELECT id::text AS id FROM public.users WHERE username LIKE 'z_invite_e2e_%'",
    );
    const abandonedFixtureIds = abandonedFixtureRows.rows.map((row) => String(row.id));
    if (abandonedFixtureIds.length > 0) {
      await client.query("BEGIN");
      try {
        await client.query(
          "DELETE FROM public.invitation_records WHERE inviter_id::text=ANY($1::text[]) OR invitee_id::text=ANY($1::text[])",
          [abandonedFixtureIds],
        );
        await client.query("DELETE FROM public.member_activation_events WHERE user_id::text=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("DELETE FROM public.user_notifications WHERE user_id::text=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("DELETE FROM public.wallet_operations WHERE user_id=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("DELETE FROM public.invitation_codes WHERE user_id::text=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [abandonedFixtureIds]);
        await client.query("COMMIT");
      } catch (recoveryError) {
        await client.query("ROLLBACK");
        throw recoveryError;
      }
    }
    report.recoveredAbandonedFixtures = abandonedFixtureIds.length;

    await client.query("BEGIN");
    for (const [id, username, displayName, invitedBy] of [
      [inviterId, `${prefix}_inviter`, inviterName, null],
      [inviteeId, `${prefix}_invitee`, inviteeName, inviterId],
    ]) {
      await client.query(
        `INSERT INTO public.users
         (id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,allowed_categories,invited_by,created_at,updated_at)
         VALUES($1,$2,'local-e2e-nonlogin-hash',$3,'student',0,0,true,'active','inactive','[]'::jsonb,$4,now(),now())`,
        [id, username, displayName, invitedBy],
      );
    }
    await client.query(
      `INSERT INTO public.invitation_codes(id,user_id,code,is_used,is_permanent,used_by,used_at,created_at)
       VALUES($1,$2,$3,true,false,$4,now(),now())`,
      [codeId, inviterId, code, inviteeId],
    );
    recordId = String((await client.query(
      `INSERT INTO public.invitation_records
       (inviter_id,invitee_id,invitee_activated,invited_at,reward_sent,invitation_code_id,invitation_code_snapshot)
       VALUES($1,$2,false,now(),false,$3,$4) RETURNING id`,
      [inviterId, inviteeId, codeId, code],
    )).rows[0].id);
    await client.query("COMMIT");

    const seeded = await client.query(
      `SELECT reward_stage,status,eligibility_at
         FROM public.invitation_reward_grants
        WHERE invitation_record_id=$1 ORDER BY reward_stage`,
      [recordId],
    );
    assert.equal(seeded.rowCount, 2, "TWO_REWARD_STAGES_REQUIRED");
    assert.ok(seeded.rows.find((row) => row.reward_stage === "registration")?.eligibility_at, "REGISTRATION_REWARD_ELIGIBILITY_REQUIRED");
    assert.equal(seeded.rows.find((row) => row.reward_stage === "activation")?.eligibility_at, null, "ACTIVATION_REWARD_MUST_START_LOCKED");
    report.assertions.realRelationSeedsTwoRewardStages = true;

    await fs.mkdir(evidenceDir, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.includes("__nextjs_original-stack-frames")) {
        report.failedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    await page.goto(`${origin}/admin?tab=invitations`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(page);
    const fixtureRow = page.getByTestId("invitation-attribution-row").filter({ hasText: inviterName });
    await fixtureRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await fixtureRow.innerText(), /等待会员激活/u);
    report.assertions.realRelationVisibleInAdmin = true;
    await page.screenshot({ path: path.join(evidenceDir, "invitation-before-dispatch-1440x900.png"), fullPage: true });

    await fixtureRow.getByRole("button", { name: "查看开放条件" }).click();
    const lockedDialog = page.getByTestId("invitation-reward-dialog");
    await lockedDialog.getByText("尚未开放派发", { exact: true }).waitFor({ state: "visible" });
    assert.match(await lockedDialog.innerText(), /激活只开放本节点，不会自动发礼包/u);
    await lockedDialog.getByRole("button", { name: "关闭礼包派发窗口" }).click();
    report.assertions.activationRewardLockedBeforeMembership = true;

    await fixtureRow.getByRole("button", { name: "处理注册礼包" }).click();
    let dialog = page.getByTestId("invitation-reward-dialog");
    await dialog.getByTestId("invitation-reward-credits").fill("123.45");
    await dialog.getByTestId("invitation-reward-cash").fill("6.78");
    await dialog.getByPlaceholder(/受邀学员已完成注册/u).fill("注册礼包浏览器实链验收");
    await dialog.getByTestId("invitation-reward-save").click();
    await page.getByTestId("invitation-reward-success").filter({ hasText: "额度已保存，尚未入账" }).waitFor({ state: "visible", timeout: 20_000 });

    const draftState = await client.query(
      `SELECT reward_grant.status,reward_grant.credits,reward_grant.cash_amount,account.credits AS user_credits,account.cash_balance
         FROM public.invitation_reward_grants AS reward_grant
         JOIN public.users account ON account.id=reward_grant.recipient_user_id::text
        WHERE reward_grant.invitation_record_id=$1 AND reward_grant.reward_stage='registration'`,
      [recordId],
    );
    assert.equal(draftState.rows[0].status, "draft");
    assert.equal(asNumber(draftState.rows[0].credits), 123.45);
    assert.equal(asNumber(draftState.rows[0].cash_amount), 6.78);
    assert.equal(asNumber(draftState.rows[0].user_credits), 0, "SAVING_DRAFT_MUST_NOT_CREDIT");
    assert.equal(asNumber(draftState.rows[0].cash_balance), 0, "SAVING_DRAFT_MUST_NOT_CREDIT_CASH");
    report.assertions.saveDecisionDoesNotMutateWallet = true;

    dialog = page.getByTestId("invitation-reward-dialog");
    page.once("dialog", async (confirmation) => confirmation.accept());
    await dialog.getByTestId("invitation-reward-send").click();
    await dialog.getByTestId("invitation-reward-receipt").waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await dialog.innerText(), /123\.45 积分/u);
    assert.match(await dialog.innerText(), /¥6\.78/u);
    report.assertions.registrationRewardDispatchedFromBrowser = true;
    await dialog.getByRole("button", { name: "关闭礼包派发窗口" }).click();

    const registrationPaid = await client.query(
      `SELECT account.credits,account.cash_balance,
              (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
              (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid AND type='invitation_reward') AS notification_count,
              (SELECT status FROM public.invitation_reward_grants WHERE invitation_record_id=$2 AND reward_stage='registration') AS reward_status
         FROM public.users AS account
        WHERE account.id=$1`,
      [inviterId, recordId],
    );
    assert.equal(asNumber(registrationPaid.rows[0].credits), 123.45);
    assert.equal(asNumber(registrationPaid.rows[0].cash_balance), 6.78);
    assert.equal(asNumber(registrationPaid.rows[0].wallet_count), 2);
    assert.equal(asNumber(registrationPaid.rows[0].notification_count), 1);
    assert.equal(registrationPaid.rows[0].reward_status, "sent");
    report.assertions.registrationWalletNotificationExactlyOnce = true;

    const activationKey = `invitation-e2e-activate:${runId}`;
    const activation = await client.query(
      "SELECT public.set_member_activation_state_atomic($1,$2,'active','admin_manual',$3,3980,$4,$5) AS result",
      [adminId, inviteeId, `local-e2e-${runId}`, "线下学费已确认，邀请闭环验收", activationKey],
    );
    assert.equal(activation.rows[0].result?.success, true, "MEMBERSHIP_ACTIVATION_REQUIRED");
    const afterActivationWallet = await client.query(
      `SELECT credits,cash_balance FROM public.users WHERE id=$1`,
      [inviterId],
    );
    assert.equal(asNumber(afterActivationWallet.rows[0].credits), 123.45, "ACTIVATION_MUST_NOT_AUTO_REWARD");
    assert.equal(asNumber(afterActivationWallet.rows[0].cash_balance), 6.78, "ACTIVATION_MUST_NOT_AUTO_REWARD_CASH");
    report.assertions.activationUnlocksButDoesNotAutoReward = true;

    await page.getByRole("button", { name: "刷新真实数据" }).click();
    const activatedRow = page.getByTestId("invitation-attribution-row").filter({ hasText: inviterName });
    await activatedRow.getByRole("button", { name: "处理正式会员礼包" }).waitFor({ state: "visible", timeout: 20_000 });
    await activatedRow.getByRole("button", { name: "处理正式会员礼包" }).click();
    dialog = page.getByTestId("invitation-reward-dialog");
    await dialog.getByTestId("invitation-reward-credits").fill("500");
    await dialog.getByTestId("invitation-reward-cash").fill("20");
    await dialog.getByPlaceholder(/受邀学员已完成注册/u).fill("正式会员礼包浏览器实链验收");
    await dialog.getByTestId("invitation-reward-save").click();
    await page.getByTestId("invitation-reward-success").filter({ hasText: "额度已保存，尚未入账" }).waitFor({ state: "visible", timeout: 20_000 });
    page.once("dialog", async (confirmation) => confirmation.accept());
    await page.getByTestId("invitation-reward-dialog").getByTestId("invitation-reward-send").click();
    await page.getByTestId("invitation-reward-dialog").getByTestId("invitation-reward-receipt").waitFor({ state: "visible", timeout: 20_000 });
    report.assertions.activationRewardDispatchedFromBrowser = true;
    await page.getByTestId("invitation-reward-dialog").getByRole("button", { name: "关闭礼包派发窗口" }).click();

    const finalState = await client.query(
      `SELECT account.credits,account.cash_balance,record.reward_sent,
              (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=$1) AS wallet_count,
              (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=$1::uuid AND type='invitation_reward') AS notification_count,
              (SELECT count(*)::integer FROM public.invitation_reward_grants WHERE invitation_record_id=$2 AND status='sent') AS sent_count
         FROM public.users account
         JOIN public.invitation_records record ON record.id=$2
        WHERE account.id=$1`,
      [inviterId, recordId],
    );
    assert.equal(asNumber(finalState.rows[0].credits), 623.45);
    assert.equal(asNumber(finalState.rows[0].cash_balance), 26.78);
    assert.equal(asNumber(finalState.rows[0].wallet_count), 4);
    assert.equal(asNumber(finalState.rows[0].notification_count), 2);
    assert.equal(asNumber(finalState.rows[0].sent_count), 2);
    assert.equal(finalState.rows[0].reward_sent, true);
    report.assertions.bothStagesCloseWithFourWalletEntriesAndTwoNotifications = true;

    await page.getByRole("button", { name: "已闭环" }).click();
    await activatedRow.waitFor({ state: "visible" });
    const layout = await page.evaluate(() => ({
      bodyText: document.body.innerText,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }));
    assert.ok(layout.horizontalOverflow <= 1, `HORIZONTAL_OVERFLOW:${layout.horizontalOverflow}`);
    assert.equal(/Application error|Internal Server Error|应用程序错误/u.test(layout.bodyText), false, "APPLICATION_ERROR_VISIBLE");
    report.assertions.closedLoopFilterShowsCompletedRelation = true;
    report.assertions.desktopHasNoGlobalHorizontalOverflow = true;
    await page.screenshot({ path: path.join(evidenceDir, "invitation-after-dispatch-1440x900.png"), fullPage: true });

    assert.deepEqual(report.failedResponses, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    report.passed = true;
    report.checkedAt = new Date().toISOString();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("BEGIN");
    try {
      if (recordId) await client.query("DELETE FROM public.invitation_records WHERE id=$1", [recordId]);
      await client.query("DELETE FROM public.member_activation_events WHERE user_id=$1", [inviteeId]);
      await client.query("DELETE FROM public.user_notifications WHERE user_id=ANY($1::uuid[])", [[inviterId, inviteeId]]);
      await client.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=ANY($1::text[])", [[inviterId, inviteeId]]);
      await client.query("DELETE FROM public.wallet_operations WHERE user_id=ANY($1::text[])", [[inviterId, inviteeId]]);
      await client.query("DELETE FROM public.invitation_codes WHERE id=$1", [codeId]);
      await client.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [[inviterId, inviteeId]]);
      await client.query("COMMIT");
    } catch (cleanupError) {
      await client.query("ROLLBACK");
      throw cleanupError;
    }
    const residue = await client.query(
      `SELECT
         (SELECT count(*)::integer FROM public.users WHERE username LIKE $1) AS users,
         (SELECT count(*)::integer FROM public.invitation_codes WHERE id=$2) AS codes,
         (SELECT count(*)::integer FROM public.invitation_records WHERE id=$3) AS records,
         (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=ANY($4::text[])) AS wallet_operations,
         (SELECT count(*)::integer FROM public.wallet_ledger_entries WHERE user_id=ANY($4::text[])) AS wallet_ledger_entries,
         (SELECT count(*)::integer FROM public.user_notifications WHERE user_id::text=ANY($5::text[])) AS notifications`,
      [`${prefix}%`, codeId, recordId || "missing", [inviterId, inviteeId], [inviterId, inviteeId]],
    );
    report.fixtureResidue = residue.rows[0];
    assert.deepEqual(Object.values(residue.rows[0]).map(Number), [0, 0, 0, 0, 0, 0], "E2E_FIXTURE_RESIDUE_DETECTED");
    await client.end();
  }

  await verifyPostCleanupPages({ origin, token, identity, evidenceDir, report });
  assert.deepEqual(report.failedResponses, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
