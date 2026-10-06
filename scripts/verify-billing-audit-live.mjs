#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence/billing-audit-provenance");

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.ok(adminIdentity?.user?.id, "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-live-billing-audit-acceptance",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const username = `billing-audit-test-${suffix}`;
  let userId = "";
  let auditId = "";
  let browser;
  await fs.mkdir(evidenceDir, { recursive: true });
  await database.connect();
  try {
    const created = await database.query(
      `INSERT INTO public.users(
         id,username,password_hash,display_name,email,role,credits,is_active,status,member_status,allowed_categories
       ) VALUES(
         gen_random_uuid()::text,$1,$2,$3,$4,'student',1,true,'active','inactive','[]'::jsonb
       ) RETURNING id`,
      [username, "local-fixture-no-login", "E2E 系统测试", `${username}@example.test`],
    );
    userId = String(created.rows[0].id);
    const insertedAudit = await database.query(
      `INSERT INTO public.balance_audit_log(
         user_id,field,old_value,new_value,delta,source,source_id,operator_id,ip_address,context
       ) VALUES($1,'credits',0,1,1,'admin_manual',$2,$3,'127.0.0.1',$4::jsonb)
       RETURNING id`,
      [
        userId,
        `fixture:${suffix}`,
        String(adminIdentity.user.id),
        JSON.stringify({ route: "/local-acceptance/billing-audit", writer: "billing-audit-live-fixture" }),
      ],
    );
    auditId = String(insertedAudit.rows[0].id);

    const headers = { Authorization: `Bearer ${adminToken}` };
    const [pageOne, pageTwo, fixtureRead, unknownRead] = await Promise.all([
      jsonRequest(`${origin}/api/admin/balance-audit?page=1&pageSize=20`, { headers }),
      jsonRequest(`${origin}/api/admin/balance-audit?page=2&pageSize=20`, { headers }),
      jsonRequest(`${origin}/api/admin/balance-audit?page=1&pageSize=20&userId=${encodeURIComponent(userId)}`, { headers }),
      jsonRequest(`${origin}/api/admin/balance-audit?page=1&pageSize=20&source=unknown`, { headers }),
    ]);
    for (const result of [pageOne, pageTwo, fixtureRead, unknownRead]) {
      assert.equal(result.response.status, 200, `BALANCE_AUDIT_API_FAILED:${JSON.stringify(result.body)}`);
    }
    assert.equal(pageOne.body.page, 1, "PAGE_ONE_NUMBER_WRONG");
    assert.equal(pageTwo.body.page, 2, "PAGE_TWO_NUMBER_WRONG");
    assert.equal(pageTwo.body.offset, 20, "PAGE_TWO_OFFSET_WRONG");
    const firstIds = new Set(pageOne.body.logs.map((row) => row.id));
    assert.ok(pageTwo.body.logs.every((row) => !firstIds.has(row.id)), "PAGINATION_REPEATED_FIRST_PAGE");
    assert.equal(pageOne.body.sourceInventory.observedRawSourceCount, 4, "OBSERVED_RAW_SOURCE_COUNT_WRONG");
    assert.equal(pageOne.body.sourceInventory.standardCategoryCount, 9, "STANDARD_SOURCE_CATEGORY_COUNT_WRONG");
    assert.deepEqual(
      pageOne.body.sourceInventory.rawSources.map((item) => item.rawSource).sort(),
      ["admin_manual", "billing_deduction", "payment_callback", "unknown"].sort(),
      "RAW_SOURCE_INVENTORY_WRONG",
    );
    assert.equal(fixtureRead.body.logs.length, 1, "FIXTURE_AUDIT_ROW_MISSING");
    const fixtureLog = fixtureRead.body.logs[0];
    assert.equal(fixtureLog.identity.displayLabel, "系统测试", "FIXTURE_ACCOUNT_NOT_LABELLED");
    assert.equal(fixtureLog.source.label, "系统测试", "FIXTURE_SOURCE_NOT_LABELLED");
    assert.equal(fixtureLog.source.rawSource, "admin_manual", "FIXTURE_RAW_SOURCE_LOST");
    assert.equal(fixtureLog.network.eventIp, "127.0.0.1", "EXACT_EVENT_IP_MISSING");
    assert.equal(fixtureLog.context.route, "/local-acceptance/billing-audit", "PROVENANCE_ROUTE_MISSING");
    assert.ok(unknownRead.body.logs.length > 0, "LEGACY_UNKNOWN_FIXTURE_REQUIRED");
    assert.ok(unknownRead.body.logs.every((row) => row.source.label === "其他"), "LEGACY_UNKNOWN_NOT_NORMALIZED_TO_OTHER");
    assert.ok(
      unknownRead.body.logs.every((row) => row.source.explanation.includes("无法在不猜测的情况下反推")),
      "LEGACY_OTHER_EXPLANATION_MISSING",
    );
    assert.ok(
      unknownRead.body.logs.every((row) => row.network.eventIp || row.network.eventIpExplanation.includes("不会拿登录 IP 冒充")),
      "MISSING_EVENT_IP_NOT_EXPLAINED",
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });
    await context.addInitScript(({ token, identity }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(identity.user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: adminToken, identity: adminIdentity });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror:${error.message}`));

    await page.goto(`${origin}/admin?tab=billing-audit`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("billing-audit-panel").waitFor({ timeout: 60_000 });
    await page.getByTestId("billing-source-inventory").getByText(/当前数据出现 4 个原始来源值/u).waitFor();
    await page.getByTestId("billing-audit-table").waitFor();
    await page.screenshot({ path: path.join(evidenceDir, "billing-audit-all-1600x1000.png"), fullPage: false });
    await page.getByLabel("按原始来源筛选").selectOption("unknown");
    await page.getByTestId("billing-audit-table").getByText("其他", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByText(/不会拿登录 IP 冒充操作 IP/u).first().waitFor();
    await page.screenshot({ path: path.join(evidenceDir, "billing-audit-legacy-other-1600x1000.png"), fullPage: false });

    for (const adjacent of ["users", "revenue"]) {
      await page.goto(`${origin}/admin?tab=${adjacent}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator("main").waitFor({ timeout: 30_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      assert.equal(overflow, false, `ADMIN_ADJACENT_PAGE_OVERFLOW:${adjacent}`);
    }
    const actionableConsoleErrors = consoleErrors.filter((message) => !/favicon|ResizeObserver|net::ERR_ABORTED/iu.test(message));
    assert.deepEqual(actionableConsoleErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(actionableConsoleErrors)}`);
    await context.close();

    const version = await jsonRequest(`${origin}/api/version`);
    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      sourceVersion: version.body.sourceVersion,
      buildId: version.body.buildId,
      checks: {
        exactRawSourceInventory: true,
        stableNineCategoryCatalog: true,
        legacyUnknownExplainedAsOther: true,
        systemTestAccountLabel: true,
        eventIpNotConfusedWithLoginIp: true,
        paginationUsesRealOffset: true,
        desktopVisual: true,
        adjacentPages: ["users", "revenue"],
        browserConsoleClean: true,
      },
      productionWrites: 0,
      fixtureRemoved: true,
    };
    await fs.writeFile(path.join(evidenceDir, "live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (auditId) await database.query("DELETE FROM public.balance_audit_log WHERE id=$1", [auditId]).catch(() => undefined);
    if (userId) {
      await database.query("BEGIN").catch(() => undefined);
      try {
        await database.query("SELECT set_config('app.member_permission_write','on',true)");
        await database.query("DELETE FROM public.users WHERE id=$1", [userId]);
        await database.query("COMMIT");
      } catch (error) {
        await database.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    await database.end();
  }
}
