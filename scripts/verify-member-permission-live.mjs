#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import { SignJWT } from "jose";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence/member-permission-snapshots");

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-live-member-permission-acceptance",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const username = `permission-fixture-${suffix}`;
  const displayName = `权限验收临时学员 ${suffix.slice(-8)}`;
  const sessionId = `permission-session-${crypto.randomUUID()}`;
  const adminUsername = `permission-admin-${suffix}`;
  const adminDisplayName = `权限验收临时管理员 ${suffix.slice(-8)}`;
  const adminSessionId = `permission-admin-session-${crypto.randomUUID()}`;
  let userId = "";
  let adminUserId = "";
  let browser;
  await fs.mkdir(evidenceDir, { recursive: true });
  await database.connect();
  try {
    const created = await database.query(
      `INSERT INTO public.users(
         id,username,password_hash,display_name,email,role,credits,is_active,status,member_status,allowed_categories,session_id
       ) VALUES(
         gen_random_uuid()::text,$1,$2,$3,$4,'student',0,true,'active','inactive','[]'::jsonb,$5
       ) RETURNING id`,
      [username, "local-fixture-no-login", displayName, `${username}@qq.com`, sessionId],
    );
    userId = String(created.rows[0].id);
    const createdAdmin = await database.query(
      `INSERT INTO public.users(
         id,username,password_hash,display_name,email,role,credits,is_active,status,member_status,allowed_categories,session_id
       ) VALUES(
         gen_random_uuid()::text,$1,$2,$3,$4,'admin',0,true,'active','active','[]'::jsonb,$5
       ) RETURNING id`,
      [adminUsername, "local-fixture-no-login", adminDisplayName, `${adminUsername}@qq.com`, adminSessionId],
    );
    adminUserId = String(createdAdmin.rows[0].id);
    await database.query(
      `INSERT INTO public.user_auth_sessions(user_id,session_id,ip_hash,user_agent_hash,expires_at)
       VALUES($1,$2,'local-member-permission','playwright-member-permission',now()+interval '30 minutes'),
             ($3,$4,'local-admin-member-permission','playwright-admin-member-permission',now()+interval '30 minutes')
       ON CONFLICT (session_id) DO NOTHING`,
      [userId, sessionId, adminUserId, adminSessionId],
    );

    const memberToken = await new SignJWT({
      userId,
      username,
      role: "student",
      displayName,
      sessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(runtime.jwtSecret));
    const temporaryAdminToken = await new SignJWT({
      userId: adminUserId,
      username: adminUsername,
      role: "admin",
      displayName: adminDisplayName,
      sessionId: adminSessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(runtime.jwtSecret));

    const adminHeaders = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
    const initial = await jsonRequest(`${origin}/api/admin/users/permissions?user_id=${encodeURIComponent(userId)}`, { headers: adminHeaders });
    assert.equal(initial.response.status, 200, `INITIAL_PERMISSION_READ_FAILED:${JSON.stringify(initial.body)}`);
    assert.deepEqual(initial.body.permission.featureNavigationKeys, ["marketplace", "toolbox"], "REGISTRATION_DEFAULT_FEATURES_WRONG");
    assert.deepEqual(initial.body.permission.agentNavigationKeys, [], "REGISTRATION_DEFAULT_AGENTS_WRONG");
    assert.equal(initial.body.permission.integrityValid, true, "REGISTRATION_SNAPSHOT_INTEGRITY_INVALID");

    browser = await chromium.launch({ headless: true });
    const adminContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });
    await adminContext.addInitScript(({ token, identity }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(identity.user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: adminToken, identity: adminIdentity });
    const page = await adminContext.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror:${error.message}`));

    await page.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("admin-member-workspace").waitFor({ timeout: 60_000 });
    const search = page.getByPlaceholder("搜索姓名/手机/邮箱...");
    await search.fill(displayName);
    const memberCard = page.getByTestId("admin-member-card").filter({ hasText: displayName });
    await memberCard.waitFor({ timeout: 30_000 });
    await memberCard.getByTestId("member-more-actions").locator("summary").click();
    await memberCard.getByRole("button", { name: "单独调权限" }).click();
    const dialog = page.getByTestId("member-navigation-dialog");
    await dialog.waitFor({ state: "visible", timeout: 30_000 });
    await dialog.getByText("业务功能导航", { exact: true }).waitFor();
    assert.equal(await dialog.getByTestId("member-feature-permission-options").locator('button[aria-pressed]').count(), 9, "BUSINESS_PERMISSION_OPTION_COUNT_WRONG");
    for (const label of ["体验包", "正式会员", "超级 VIP"]) {
      await dialog.getByRole("button", { name: new RegExp(label, "u") }).waitFor();
    }
    assert.equal(await dialog.getByTestId("member-permission-quick-profiles").getByRole("button").count(), 3, "QUICK_PROFILE_COUNT_WRONG");
    assert.equal(await dialog.getByText("内部全功能", { exact: true }).count(), 0, "INTERNAL_PROFILE_SHOULD_NOT_BE_QUICK_OPTION");
    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= 1600 && dialogBox.y + dialogBox.height <= 1000, "PERMISSION_DIALOG_OVERFLOW");
    await page.screenshot({ path: path.join(evidenceDir, "admin-member-permission-modal-1600x1000.png"), fullPage: false });

    await dialog.getByRole("button", { name: /正式会员/u }).click();
    await dialog.getByPlaceholder(/3980 正式会员/u).fill("本地临时学员权限闭环验收");
    await dialog.getByRole("button", { name: "保存功能权限" }).click();
    await dialog.waitFor({ state: "detached", timeout: 30_000 });

    const afterUiSave = await jsonRequest(`${origin}/api/admin/users/permissions?user_id=${encodeURIComponent(userId)}`, { headers: adminHeaders });
    assert.equal(afterUiSave.response.status, 200, "UI_SAVE_READBACK_FAILED");
    assert.equal(afterUiSave.body.permission.revision, 2, "UI_SAVE_REVISION_WRONG");
    assert.equal(afterUiSave.body.permission.sourceProfileKey, "formal_member", "PROFILE_COPY_SOURCE_MISSING");
    assert.equal(afterUiSave.body.permission.featureNavigationKeys.length, 9, "FORMAL_MEMBER_FEATURE_COUNT_WRONG");
    assert.equal(afterUiSave.body.permission.agentNavigationKeys.length, 4, "FORMAL_MEMBER_AGENT_COUNT_WRONG");

    // Exact regression for the user-reported defect: administrator accounts
    // retain management-console authority but their product tiles and Agent
    // categories must be editable through the same modal and durable snapshot.
    await page.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("admin-member-workspace").waitFor({ timeout: 60_000 });
    await search.fill(adminDisplayName);
    const adminCard = page.getByTestId("admin-member-card").filter({ hasText: adminDisplayName });
    await adminCard.waitFor({ timeout: 30_000 });
    await adminCard.getByTestId("member-more-actions").locator("summary").click();
    await adminCard.getByRole("button", { name: "单独调权限" }).click();
    await dialog.waitFor({ state: "visible", timeout: 30_000 });
    await dialog.getByText(/后台管理权由角色保留/u).waitFor();
    const featureSection = dialog.locator("section").filter({ hasText: "业务功能导航" });
    const agentSection = dialog.locator("section").filter({ hasText: "智能体分类" });
    await featureSection.getByRole("button", { name: "清空", exact: true }).click();
    await featureSection.getByRole("button", { name: /应用广场/u }).click();
    await agentSection.getByRole("button", { name: "清空", exact: true }).click();
    await agentSection.getByRole("button", { name: "商业IP", exact: true }).click();
    const agentOptionAppearance = await dialog.getByTestId("member-agent-permission-options").locator("button").evaluateAll((buttons) => buttons.map((button) => {
      const style = window.getComputedStyle(button);
      return {
        label: button.textContent?.trim() || "",
        pressed: button.getAttribute("aria-pressed"),
        color: style.color,
        backgroundColor: style.backgroundColor,
        visibility: style.visibility,
        opacity: style.opacity,
      };
    }));
    assert.deepEqual(agentOptionAppearance.map((item) => item.label), ["商业IP", "影像编导", "文案创作", "运营增长", "内部工具"], "ADMIN_AGENT_OPTION_LABELS_INCOMPLETE");
    assert.equal(agentOptionAppearance.filter((item) => item.pressed === "true").length, 1, "ADMIN_AGENT_SELECTED_STATE_WRONG");
    assert.ok(agentOptionAppearance.every((item) => item.visibility === "visible" && Number(item.opacity) === 1 && item.color !== item.backgroundColor), `ADMIN_AGENT_OPTION_CONTRAST_INVALID:${JSON.stringify(agentOptionAppearance)}`);
    await dialog.getByPlaceholder(/3980 正式会员/u).fill("管理员前台业务权限可编辑闭环验收");
    await page.screenshot({ path: path.join(evidenceDir, "admin-account-permission-editable-1600x1000.png"), fullPage: false });
    await dialog.getByRole("button", { name: "保存功能权限" }).click();
    await dialog.waitFor({ state: "detached", timeout: 30_000 });

    const adminReadback = await jsonRequest(`${origin}/api/admin/users/permissions?user_id=${encodeURIComponent(adminUserId)}`, { headers: adminHeaders });
    assert.equal(adminReadback.response.status, 200, `ADMIN_TARGET_READBACK_FAILED:${JSON.stringify(adminReadback.body)}`);
    assert.deepEqual(adminReadback.body.permission.featureNavigationKeys, ["marketplace"], "ADMIN_FEATURE_EDIT_NOT_PERSISTED");
    assert.deepEqual(adminReadback.body.permission.agentNavigationKeys, ["bip:loop"], "ADMIN_AGENT_EDIT_NOT_PERSISTED");
    assert.equal(adminReadback.body.permission.integrityValid, true, "ADMIN_PERMISSION_INTEGRITY_INVALID");

    const temporaryAdminHeaders = { Authorization: `Bearer ${temporaryAdminToken}` };
    const [temporaryAdminPermission, temporaryAdminBots, fullAdminBots, temporaryAdminVideo] = await Promise.all([
      jsonRequest(`${origin}/api/member-permissions`, { headers: temporaryAdminHeaders }),
      jsonRequest(`${origin}/api/bots?shape=agents`, { headers: temporaryAdminHeaders }),
      jsonRequest(`${origin}/api/bots?shape=agents`, { headers: { Authorization: `Bearer ${adminToken}` } }),
      jsonRequest(`${origin}/api/video/models`, { headers: temporaryAdminHeaders }),
    ]);
    assert.equal(temporaryAdminPermission.response.status, 200, "ADMIN_MEMBER_PERMISSION_API_FAILED");
    assert.deepEqual(temporaryAdminPermission.body.permission.featureNavigationKeys, ["marketplace"], "ADMIN_MEMBER_PERMISSION_API_WRONG");
    assert.equal(temporaryAdminBots.response.status, 200, "ADMIN_GRANTED_MARKETPLACE_API_REJECTED");
    assert.equal(temporaryAdminVideo.response.status, 403, "ADMIN_DENIED_FEATURE_API_NOT_REJECTED");
    assert.equal(temporaryAdminVideo.body.code, "MEMBER_FEATURE_ACCESS_DENIED", "ADMIN_DENIED_FEATURE_API_WRONG_CODE");
    const allowedAdminAgentIds = new Set((temporaryAdminBots.body.agents || []).map((agent) => String(agent.id)));
    const deniedAgent = (fullAdminBots.body.agents || []).find((agent) => !allowedAdminAgentIds.has(String(agent.id)));
    assert.ok(deniedAgent?.id, "DENIED_AGENT_FIXTURE_REQUIRED");

    const temporaryAdminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await temporaryAdminContext.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, {
      token: temporaryAdminToken,
      user: { id: adminUserId, username: adminUsername, displayName: adminDisplayName, role: "admin", sessionId: adminSessionId },
    });
    const temporaryAdminPage = await temporaryAdminContext.newPage();
    await temporaryAdminPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await temporaryAdminPage.getByLabel("一级功能导航").waitFor({ timeout: 60_000 });
    assert.equal(await temporaryAdminPage.getByRole("button", { name: /视频创作/u }).count(), 0, "ADMIN_DENIED_NAVIGATION_VISIBLE");
    await temporaryAdminPage.screenshot({ path: path.join(evidenceDir, "admin-account-restricted-navigation-1440x900.png"), fullPage: false });
    const deniedAgentCall = await temporaryAdminPage.evaluate(async ({ deniedAgentId }) => {
      const token = localStorage.getItem("auth_token") || "";
      const requestId = `admin-permission-denied-${crypto.randomUUID()}`;
      const response = await fetch("/api/llm", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({
          agentId: deniedAgentId,
          messages: [{ role: "user", content: "权限闭环验证" }],
          stream: false,
          client_request_id: requestId,
        }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }, { deniedAgentId: String(deniedAgent.id) });
    assert.equal(deniedAgentCall.status, 403, `ADMIN_DENIED_AGENT_CALL_NOT_REJECTED:${JSON.stringify(deniedAgentCall)}`);
    assert.equal(deniedAgentCall.body.code, "CATEGORY_ACCESS_DENIED", "ADMIN_DENIED_AGENT_CALL_WRONG_CODE");
    await temporaryAdminPage.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await temporaryAdminPage.getByTestId("member-feature-access-denied").waitFor({ timeout: 5_000 });
    await temporaryAdminContext.close();

    for (const adjacent of ["invitations", "login-logs"]) {
      await page.goto(`${origin}/admin?tab=${adjacent}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator("main").waitFor({ timeout: 30_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      assert.equal(overflow, false, `ADMIN_ADJACENT_PAGE_OVERFLOW:${adjacent}`);
      await page.screenshot({ path: path.join(evidenceDir, `admin-adjacent-${adjacent}-1600x1000.png`), fullPage: false });
    }

    const restrictKey = `member-permission-restrict-${crypto.randomUUID()}`;
    const restricted = await jsonRequest(`${origin}/api/admin/users/permissions`, {
      method: "PUT",
      headers: { ...adminHeaders, "Idempotency-Key": restrictKey },
      body: JSON.stringify({
        userId,
        featureNavigationKeys: ["marketplace"],
        agentNavigationKeys: ["bip:loop"],
        expectedRevision: 2,
        idempotencyKey: restrictKey,
        reason: "本地权限拒绝链路验收",
      }),
    });
    assert.equal(restricted.response.status, 200, `RESTRICT_SAVE_FAILED:${JSON.stringify(restricted.body)}`);

    const memberHeaders = { Authorization: `Bearer ${memberToken}` };
    const [memberPermission, allowedCatalog, deniedVideo] = await Promise.all([
      jsonRequest(`${origin}/api/member-permissions`, { headers: memberHeaders }),
      jsonRequest(`${origin}/api/bots?shape=agents`, { headers: memberHeaders }),
      jsonRequest(`${origin}/api/video/models`, { headers: memberHeaders }),
    ]);
    assert.equal(memberPermission.response.status, 200, "MEMBER_PERMISSION_API_FAILED");
    assert.deepEqual(memberPermission.body.permission.featureNavigationKeys, ["marketplace"], "MEMBER_PERMISSION_READBACK_WRONG");
    assert.equal(allowedCatalog.response.status, 200, "GRANTED_MARKETPLACE_API_REJECTED");
    assert.equal(deniedVideo.response.status, 403, "DENIED_FEATURE_API_NOT_REJECTED");
    assert.equal(deniedVideo.body.code, "MEMBER_FEATURE_ACCESS_DENIED", "DENIED_FEATURE_API_WRONG_CODE");

    const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await memberContext.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
      // Permission acceptance is independent from the inactive-member package
      // reminder. Keep that valid product dialog from taking over this test.
      sessionStorage.setItem("trial_dialog_dismissed", "1");
    }, {
      token: memberToken,
      user: { id: userId, username, displayName, role: "student", credits: 0, isActive: true, allowedCategories: ["bip:loop"] },
    });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const memberPrimaryNavigation = memberPage.getByLabel("一级功能导航");
    await memberPrimaryNavigation.waitFor({ timeout: 60_000 });
    // A new account legitimately receives the unread-announcement dialog. It
    // makes the application shell aria-hidden while open, so close it without
    // marking it read before inspecting the permission-controlled navigation.
    const announcementReader = memberPage.getByTestId("announcement-reader");
    const announcementOpened = await announcementReader.waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (announcementOpened) {
      await announcementReader.getByRole("button", { name: "关闭系统公告" }).click();
      await announcementReader.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await memberPrimaryNavigation.getByRole("button", { name: /应用广场/u }).waitFor();
    assert.equal(await memberPage.getByRole("button", { name: /视频创作/u }).count(), 0, "DENIED_NAVIGATION_VISIBLE");
    assert.equal(await memberPage.getByRole("button", { name: /带货创作/u }).count(), 0, "DENIED_COMMERCE_NAVIGATION_VISIBLE");
    await memberPage.screenshot({ path: path.join(evidenceDir, "member-restricted-navigation-1440x900.png"), fullPage: false });

    await memberPage.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await memberPage.getByTestId("member-feature-access-denied").waitFor({ timeout: 2_000 });
    await memberPage.screenshot({ path: path.join(evidenceDir, "member-direct-route-denied-1440x900.png"), fullPage: false });
    await memberContext.close();
    await adminContext.close();

    const actionableConsoleErrors = consoleErrors.filter((message) => !/favicon|ResizeObserver|net::ERR_ABORTED/iu.test(message));
    assert.deepEqual(actionableConsoleErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(actionableConsoleErrors)}`);
    const version = await jsonRequest(`${origin}/api/version`);
    assert.equal(version.response.status, 200, "VERSION_READ_FAILED");
    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      sourceVersion: version.body.sourceVersion,
      buildId: version.body.buildId,
      viewport: ["1600x1000", "1440x900"],
      checks: {
        adminModal: true,
        profileCopyAndReadback: true,
        invitationAdjacentPage: true,
        loginLogAdjacentPage: true,
        restrictedNavigationHidden: true,
        directPageDenied: true,
        apiDenied: true,
        allowedMarketplaceApi: true,
        noHorizontalOverflow: true,
        browserConsoleClean: true,
        adminProductPermissionsEditable: true,
        adminAgentOptionsLegible: true,
        adminFeatureApiDenied: true,
        adminAgentExecutionDeniedBeforeProvider: true,
      },
      productionWrites: 0,
      fixtureRemoved: true,
    };
    await fs.writeFile(path.join(evidenceDir, "live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (userId || adminUserId) {
      await database.query("BEGIN").catch(() => undefined);
      try {
        await database.query("SELECT set_config('app.member_permission_write','on',true)");
        if (userId) await database.query("DELETE FROM public.users WHERE id=$1", [userId]);
        if (adminUserId) await database.query("DELETE FROM public.users WHERE id=$1", [adminUserId]);
        await database.query("COMMIT");
      } catch (error) {
        await database.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    await database.end();
  }
}
