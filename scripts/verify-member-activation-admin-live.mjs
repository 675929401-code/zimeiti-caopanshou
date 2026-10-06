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
const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow", "live");

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function jsonGet(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${pathname}:${payload?.error || response.status}`);
  return payload;
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

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");

  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-live-member-activation-admin", connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  const snapshot = async () => {
    const result = await client.query(
      `SELECT
         (SELECT jsonb_agg(jsonb_build_object('id',id,'member_status',member_status,'updated_at',updated_at) ORDER BY id) FROM public.users) AS users,
         (SELECT count(*)::integer FROM public.member_activation_events) AS activation_events,
         (SELECT count(*)::integer FROM public.offline_payment_receipts) AS offline_receipts,
         (SELECT count(*)::integer FROM public.invitation_reward_grants WHERE status='sent') AS sent_rewards,
         (SELECT count(*)::integer FROM public.wallet_operations) AS wallet_operations,
         (SELECT count(*)::integer FROM public.user_notifications) AS notifications`,
    );
    return result.rows[0];
  };
  const before = await snapshot();

  try {
    const [usersPayload, invitationPayload, camiPayload, offlinePayload, reconciliationPayload] = await Promise.all([
      jsonGet("/api/admin/users?page_size=500"),
      jsonGet("/api/admin/invitations?page=1&pageSize=20"),
      jsonGet("/api/admin/cami?page=1&size=20"),
      jsonGet("/api/admin/offline-payments?page=1&pageSize=30"),
      jsonGet("/api/admin/reconciliation/recharges?summaryOnly=1"),
    ]);
    assert.ok(Array.isArray(usersPayload.users), "USERS_RESPONSE_INVALID");
    assert.ok(Array.isArray(invitationPayload.records), "INVITATIONS_RESPONSE_INVALID");
    assert.ok(Array.isArray(camiPayload.codes), "CAMI_RESPONSE_INVALID");
    assert.ok(Array.isArray(offlinePayload.receipts), "OFFLINE_RECEIPTS_RESPONSE_INVALID");
    assert.equal(typeof reconciliationPayload.summary?.offlineConfirmedAmount, "number", "OFFLINE_RECONCILIATION_SUMMARY_MISSING");

    const normalMember = usersPayload.users.find((user) => user.role !== "admin" && user.accountKind !== "fixture");
    assert.ok(normalMember?.id, "NORMAL_MEMBER_REQUIRED");
    const lifecyclePayload = await jsonGet(`/api/admin/users/lifecycle?userId=${encodeURIComponent(normalMember.id)}`);
    assert.ok(Array.isArray(lifecyclePayload.events), "LIFECYCLE_RESPONSE_INVALID");
    assert.equal(typeof lifecyclePayload.summary?.offlinePaymentCount, "number", "LIFECYCLE_OFFLINE_SUMMARY_MISSING");

    const [companyCsvResponse, memberCsvResponse] = await Promise.all([
      fetch(`${origin}/api/admin/reconciliation/recharges?format=csv`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      }),
      fetch(`${origin}/api/admin/reconciliation/recharges?format=csv&userId=${encodeURIComponent(normalMember.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      }),
    ]);
    const [companyCsvBytes, memberCsvBytes] = await Promise.all([
      companyCsvResponse.arrayBuffer().then((value) => Buffer.from(value)),
      memberCsvResponse.arrayBuffer().then((value) => Buffer.from(value)),
    ]);
    for (const [scope, response, bytes] of [
      ["company", companyCsvResponse, companyCsvBytes],
      ["member", memberCsvResponse, memberCsvBytes],
    ]) {
      const csv = bytes.toString("utf8");
      assert.equal(response.status, 200, `RECONCILIATION_CSV_FAILED:${scope}:${response.status}`);
      assert.match(String(response.headers.get("content-type") || ""), /^text\/csv/u, `RECONCILIATION_CSV_TYPE_INVALID:${scope}`);
      assert.match(String(response.headers.get("content-disposition") || ""), /attachment/u, `RECONCILIATION_CSV_DISPOSITION_INVALID:${scope}`);
      assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf", `RECONCILIATION_CSV_BOM_MISSING:${scope}`);
      for (const header of ["线下收款凭证ID", "线下交易流水号", "付款方脱敏标识", "会员激活事件ID", "作废原因"]) {
        assert.ok(csv.includes(header), `RECONCILIATION_CSV_HEADER_MISSING:${scope}:${header}`);
      }
    }

    const bypassKey = `verify-evidence-gate:${normalMember.id}:${crypto.randomUUID()}`;
    const bypassResponse = await fetch(`${origin}/api/admin/users`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": bypassKey },
      body: JSON.stringify({ userId: normalMember.id, memberStatus: "active", activationMethod: "admin_manual", activationFee: 3980, idempotencyKey: bypassKey }),
      signal: AbortSignal.timeout(20_000),
    });
    const bypassPayload = await bypassResponse.json().catch(() => ({}));
    assert.equal(bypassResponse.status, 409, "DIRECT_MEMBER_ACTIVATION_MUST_BE_REJECTED");
    assert.equal(bypassPayload.code, "MEMBER_ACTIVATION_REQUIRES_EVIDENCE");

    const retiredApiResponse = await fetch(`${origin}/api/admin/canvas-prompt-presets`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(retiredApiResponse.status, 410, "ADMIN_CANVAS_PROMPTS_MUST_BE_RETIRED");
    const freeCanvasResponse = await fetch(`${origin}/free-canvas`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    assert.ok([307, 308].includes(freeCanvasResponse.status), `RETIRED_ROUTE_REDIRECT_REQUIRED:/free-canvas:${freeCanvasResponse.status}`);
    assert.match(String(freeCanvasResponse.headers.get("location") || ""), /^\/storyboard-workbench\?legacy=/u, "RETIRED_ROUTE_TARGET_INVALID:/free-canvas");
    const toolsCanvasResponse = await fetch(`${origin}/tools/canvas`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    assert.ok([307, 308].includes(toolsCanvasResponse.status), `RETIRED_ROUTE_REDIRECT_REQUIRED:/tools/canvas:${toolsCanvasResponse.status}`);
    assert.match(String(toolsCanvasResponse.headers.get("location") || ""), /^\/storyboard-workbench\?legacy=canvas-entry/u, "RETIRED_ROUTE_TARGET_INVALID:/tools/canvas");

    await fs.mkdir(evidenceDir, { recursive: true });
    const report = {
      checkedAt: new Date().toISOString(),
      source: "LIVE_LOCAL_ADMIN_AND_REAL_GET_APIS",
      viewports: [],
      routes: [],
      failedResponses: [],
      pageErrors: [],
      consoleErrors: [],
      blockedWrites: [],
      suppressedDiagnostics: [],
      excludedRequests: [],
      api: {
        users: usersPayload.users.length,
        invitations: invitationPayload.records.length,
        cards: camiPayload.codes.length,
        offlineReceipts: offlinePayload.receipts.length,
        companyReconciliationCsv: true,
        memberReconciliationCsv: true,
        directActivationRejected: true,
        retiredCanvasApi: true,
        retiredCanvasRoutes: true,
      },
    };

    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (/^\/api\/(?:commerce|admin\/manju)(?:\/|$)/u.test(url.pathname)) {
            report.excludedRequests.push(`${request.method()} ${url.pathname}`);
            await route.abort("blockedbyclient");
            return;
          }
          const diagnostic = request.method() === "POST" && url.origin === origin && url.pathname === "/__nextjs_original-stack-frames";
          const operationDiagnostic = request.method() === "POST"
            && url.origin === origin
            && ["/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname);
          if (operationDiagnostic) {
            report.suppressedDiagnostics.push(`${request.method()} ${url.pathname}`);
            await route.abort("blockedbyclient");
            return;
          }
          if (request.method() !== "GET" && !diagnostic) {
            report.blockedWrites.push(`${request.method()} ${url.pathname}`);
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
        page.on("pageerror", (error) => report.pageErrors.push(String(error?.message || error)));
        page.on("console", (message) => {
          if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) report.consoleErrors.push(message.text().slice(0, 500));
        });
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === origin && url.pathname.startsWith("/api/") && response.status() >= 400) report.failedResponses.push(`${response.status()} ${url.pathname}`);
        });

        await page.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.getByRole("navigation", { name: "管理后台功能导航" }).waitFor({ state: "visible", timeout: 30_000 });
        await closeOptionalOverlays(page);
        const sideNav = page.getByRole("navigation", { name: "管理后台功能导航" });
        for (const label of ["会员管理", "资金与计费", "工作台配置", "基本设置", "界面设置", "安全中心", "系统运维"]) {
          assert.equal(await sideNav.getByRole("button", { name: label, exact: true }).count(), 1, `PRIMARY_ADMIN_HUB_MISSING:${label}`);
        }
        assert.equal(await sideNav.getByRole("button", { name: "画布提示词", exact: true }).count(), 0, "RETIRED_CANVAS_ADMIN_NAV_VISIBLE");
        const memberModule = page.getByTestId("admin-module-users");
        for (const label of ["学员档案", "邀请关系", "卡密管理", "试用套餐", "登录日志"]) {
          assert.equal(await memberModule.getByRole("button", { name: label, exact: true }).count(), 1, `MEMBER_SUBTAB_MISSING:${label}`);
        }
        await page.getByRole("button", { name: "运营档案", exact: true }).first().click();
        await page.getByRole("heading", { name: "学员 360° 运营档案", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
        await page.getByText("今日成功登录", { exact: true }).waitFor({ state: "visible" });
        await page.getByText("累计实际消耗", { exact: true }).waitFor({ state: "visible" });
        await page.getByRole("button", { name: "关闭运营档案", exact: true }).click();
        report.routes.push({ viewport, tab: "users", passed: true });

        await page.goto(`${origin}/admin?tab=offline-payments&member=${encodeURIComponent(normalMember.id)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.getByTestId("offline-payments-workspace").waitFor({ state: "visible", timeout: 30_000 });
        await closeOptionalOverlays(page);
        const financeModule = page.getByTestId("admin-module-credits");
        for (const label of ["积分与现金", "线下收款", "计费审计", "支付配置"]) {
          assert.equal(await financeModule.getByRole("button", { name: label, exact: true }).count(), 1, `FINANCE_SUBTAB_MISSING:${label}`);
        }
        await page.getByText("数据安全边界", { exact: true }).waitFor({ state: "visible" });
        await page.getByText(/当前从学员档案进入/u).waitFor({ state: "visible" });
        assert.equal(await page.getByTestId("offline-payment-submit").isDisabled(), true, "OFFLINE_PAYMENT_SUBMIT_MUST_REQUIRE_CONFIRMATION");
        const layout = await page.evaluate(() => ({
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          bodyText: document.body.innerText,
        }));
        assert.ok(layout.horizontalOverflow <= 1, `OFFLINE_PAYMENT_HORIZONTAL_OVERFLOW:${viewport.width}:${layout.horizontalOverflow}`);
        assert.equal(/Application error|Internal Server Error|应用程序错误/u.test(layout.bodyText), false, "OFFLINE_PAYMENT_APPLICATION_ERROR");
        await page.getByRole("button", { name: "查看全部学员", exact: true }).click();
        await page.screenshot({ path: path.join(evidenceDir, `offline-payments-${viewport.width}x${viewport.height}.png`), fullPage: true });
        report.routes.push({ viewport, tab: "offline-payments", passed: true, horizontalOverflow: layout.horizontalOverflow });

        if (viewport.width === 1440) {
          for (const tab of ["invitations", "cami", "login-logs", "credits", "theme", "security"]) {
            await page.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
            await page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
            await closeOptionalOverlays(page);
            const adjacent = await page.evaluate(() => ({
              textLength: document.querySelector("main")?.textContent?.trim().length || 0,
              overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            }));
            assert.ok(adjacent.textLength > 30, `ADMIN_TAB_EMPTY:${tab}`);
            assert.ok(adjacent.overflow <= 1, `ADMIN_TAB_OVERFLOW:${tab}:${adjacent.overflow}`);
            report.routes.push({ viewport, tab, passed: true, horizontalOverflow: adjacent.overflow });
            if (tab === "theme" || tab === "security") await page.screenshot({ path: path.join(evidenceDir, `${tab}-${viewport.width}x${viewport.height}.png`), fullPage: true });
          }
          await page.goto(`${origin}/admin?tab=credits`, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.getByRole("heading", { name: "积分充值", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
          const notificationToggles = page.locator("label").filter({ hasText: "默认不通知" }).locator('input[type="checkbox"]');
          assert.equal(await notificationToggles.count(), 3, "WALLET_NOTIFICATION_OPT_IN_CONTROLS_MISSING");
          for (let index = 0; index < 3; index += 1) assert.equal(await notificationToggles.nth(index).isChecked(), false, `WALLET_NOTIFICATION_MUST_DEFAULT_OFF:${index}`);
          for (const route of ["/free-canvas", "/tools/canvas"]) {
            await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
            await page.waitForURL((url) => url.pathname === "/storyboard-workbench" && url.searchParams.has("legacy"), { timeout: 15_000 });
            report.routes.push({ viewport, tab: route, finalPath: `${new URL(page.url()).pathname}${new URL(page.url()).search}`, passed: true });
          }
        }

        report.viewports.push(viewport);
        await context.close();
      }
    } finally {
      await browser.close();
    }

    const after = await snapshot();
    assert.equal(stableHash(after), stableHash(before), "LIVE_ACCEPTANCE_DATABASE_STATE_CHANGED");
    assert.deepEqual(report.excludedRequests, [], "EXCLUDED_COMMERCE_OR_MANJU_REQUEST_DETECTED");
    assert.deepEqual(report.blockedWrites, [], "UNEXPECTED_BROWSER_WRITE_REQUESTS");
    report.operationFlightRecorderObserved = report.suppressedDiagnostics.some((entry) => entry.endsWith("/api/operation-events"));
    assert.deepEqual([...new Set(report.failedResponses)], [], "LIVE_ADMIN_API_FAILURES");
    assert.deepEqual(report.pageErrors, [], "LIVE_ADMIN_PAGE_ERRORS");
    assert.deepEqual(report.consoleErrors, [], "LIVE_ADMIN_CONSOLE_ERRORS");

    const evidence = {
      passed: true,
      ...report,
      databaseStateUnchanged: true,
      databaseWrites: 0,
      paidCalls: 0,
      providerCalls: 0,
      productionWrites: 0,
    };
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
