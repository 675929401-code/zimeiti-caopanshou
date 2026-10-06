import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const realReadonly = process.argv.includes("--real-readonly");
const evidenceDir = path.resolve(process.cwd(), ".codex-evidence", "extraction-reconciliation-ui-zero-cost-20261004");

const records = [
  {
    record_id: "a".repeat(64),
    user_id: "fixture-user-a",
    client_request_id: "extract-fixture-a",
    request_kind: "video",
    payload_fingerprint: "b".repeat(64),
    state: "failed_unknown",
    http_status: 503,
    provider_task_id: "provider-task-a",
    provider_evidence: { provider_status: "unknown" },
    billing_evidence: { wallet_state: "reserved" },
    error_code: "EXTRACTION_RESPONSE_ERROR",
    error_message: "上游返回状态未知，需要人工核对",
    created_at: "2026-09-13T01:00:00.000Z",
    updated_at: "2026-09-13T01:05:00.000Z",
  },
  {
    record_id: "c".repeat(64),
    user_id: "fixture-user-b",
    client_request_id: "extract-fixture-b",
    request_kind: "text",
    payload_fingerprint: "d".repeat(64),
    state: "running",
    http_status: null,
    provider_task_id: "provider-task-b",
    provider_evidence: {},
    billing_evidence: {},
    error_code: null,
    error_message: null,
    created_at: "2026-09-13T02:00:00.000Z",
    updated_at: "2026-09-13T02:30:00.000Z",
  },
];

function json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(payload),
  });
}

export async function main() {
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN is required");
  await mkdir(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await context.addInitScript(({ authToken }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify({ id: "fixture-admin", role: "admin" }));
  }, { authToken: token });

  let submitted = false;
  const postBodies = [];
  const unexpectedWrites = [];
  const interceptedTelemetryWrites = [];
  const externalRequests = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (url.origin !== baseUrl) {
      externalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (pathname === "/api/auth/me") {
      await json(route, { user: { id: "fixture-admin", username: "fixture-admin", display_name: "验收管理员", role: "admin" } });
      return;
    }
    if (pathname === "/api/admin/access-control/self") {
      await json(route, {
        access: {
          authorityStatus: "ready",
          integrityValid: true,
          adminLevel: "super_admin",
          permissionKeys: ["billing.view", "wallet.adjust"],
          revision: 7,
          profileActive: true,
          updatedAt: "2026-10-04T00:00:00.000Z",
        },
        stepUp: { status: "ready", expiresAt: "2099-12-31T23:59:59.000Z", authMethod: "login_password" },
        tabAccess: {},
        managementPasswordSet: true,
        catalog: [],
      });
      return;
    }
    if (pathname === "/api/member-permissions") {
      await json(route, {
        permission: {
          userId: "fixture-admin",
          role: "admin",
          featureNavigationKeys: ["toolbox"],
          agentNavigationKeys: [],
          revision: 1,
          checksum: "fixture-checksum",
          sourceProfileKey: null,
          sourceProfileVersion: null,
          updatedAt: "2026-10-04T00:00:00.000Z",
          updatedBy: "fixture-admin",
          reason: "zero-cost adjacent-page acceptance",
          integrityValid: true,
          authorityStatus: "admin",
        },
      });
      return;
    }
    if (pathname === "/api/extract/reconciliation" && request.method() === "GET") {
      if (realReadonly) await route.continue();
      else await json(route, { records: submitted ? records.slice(1) : records, provider_calls: 0 });
      return;
    }
    if (pathname === "/api/extract/reconciliation" && request.method() === "POST") {
      postBodies.push(JSON.parse(request.postData() || "{}"));
      submitted = true;
      await json(route, { success: true, record: { ...records[0], state: "failed" }, provider_calls: 0, audit_written: true });
      return;
    }
    if (["/api/operation-events", "/api/diagnostic-logs", "/api/product-usage/events"].includes(pathname)
      && request.method() === "POST") {
      interceptedTelemetryWrites.push(pathname);
      await json(route, { success: true, fixture: true });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      unexpectedWrites.push({ method: request.method(), path: pathname });
      await json(route, { error: "unexpected write blocked by zero-cost acceptance" }, 409);
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/admin/extraction-reconciliation`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "提取任务人工对账" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByText("待人工核对").waitFor({ state: "visible" });
  assert.match(await page.locator("main").innerText(), /禁止猜测终态/u);
  assert.match(await page.locator("main").innerText(), /不会联系供应商/u);
  await page.getByText(/敏感操作已解锁至/u).waitFor({ state: "visible", timeout: 5_000 });

  if (realReadonly) {
    await page.waitForFunction(() => document.querySelectorAll("main aside button").length > 0, null, { timeout: 10_000 });
    const actualRecordCount = await page.locator("main aside button").count();
    assert.equal(actualRecordCount, 5, "the current local database must expose the five known unresolved extraction attempts");
    assert.equal(postBodies.length, 0, "real read-only acceptance must never submit reconciliation");
    assert.deepEqual(unexpectedWrites, [], "real read-only acceptance must block every unexpected write");
    const screenshot = path.join(evidenceDir, "reconciliation-real-readonly-1440x900.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    const report = {
      passed: true,
      mode: "real-readonly",
      baseUrl,
      buildId: await (await fetch(`${baseUrl}/api/version`)).json().then((value) => value.buildId || value.build_id || null).catch(() => null),
      actualRecordCount,
      realDatabaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      unexpectedWrites,
      interceptedTelemetryWrites,
      externalRequests,
      pageErrors,
      screenshot,
    };
    await writeFile(path.join(evidenceDir, "real-readonly-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    await context.close();
    await browser.close();
    return;
  }

  assert.equal(await page.getByRole("button").filter({ hasText: "extract-fixture" }).count(), 2, "fixture record list must render both unresolved attempts");

  await page.getByRole("button").filter({ hasText: "确认失败" }).click();
  const evidenceSourceLabels = page.locator("label").filter({ hasText: /^证据来源/u });
  await evidenceSourceLabels.nth(0).locator("select").selectOption("provider_api_readback");
  await page.getByLabel("供应商状态").fill("failed");
  await page.getByLabel("确认终态").fill("failure");
  await page.getByLabel("是否已发起供应商调用").selectOption("true");
  await page.getByLabel("证据说明").fill("供应商接口按精确任务 ID 回读为失败终态，未取得可交付内容。");
  await evidenceSourceLabels.nth(1).locator("select").selectOption("finance_ledger");
  await page.getByLabel("钱包账本状态").fill("no_charge");
  await page.getByLabel("是否扣费").selectOption("false");
  await page.getByLabel("是否退款").selectOption("false");
  await page.getByLabel("实际扣除积分").fill("0");
  await page.getByLabel("实际退回积分").fill("0");
  await page.getByLabel("HTTP 状态").fill("503");
  await page.getByLabel("可回放响应 JSON").fill(JSON.stringify({ success: false, error: "provider terminal failure" }));
  await page.getByLabel("对账理由").fill("供应商终态与平台钱包账本已分别核实，本次确认失败且没有扣费。");
  await page.getByText(/请输入 确认/u).locator("xpath=following::input[1]").fill(`确认 ${records[0].record_id.slice(-8)}`);
  await page.getByRole("button", { name: "提交并写入审计" }).click();
  try {
    await page.getByText(/对账证据已原子写入/u).waitFor({ state: "visible", timeout: 5_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(evidenceDir, "reconciliation-submit-failure.png"), fullPage: true });
    const bodyText = (await page.locator("body").innerText()).slice(-4_000);
    throw new Error(`reconciliation submit did not reach success; posts=${postBodies.length}; body=${bodyText}; cause=${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(postBodies.length, 1, "one operator click must produce exactly one reconciliation POST");
  assert.equal(postBodies[0].record_id, records[0].record_id);
  assert.equal(postBodies[0].expected_updated_at, records[0].updated_at);
  assert.equal(postBodies[0].target_state, "failed");
  assert.equal(postBodies[0].provider_evidence.evidence_source, "provider_api_readback");
  assert.equal(postBodies[0].provider_evidence.provider_call_started, true);
  assert.equal(postBodies[0].billing_evidence.wallet_state, "no_charge");
  assert.equal(postBodies[0].billing_evidence.charged, false);
  assert.equal(postBodies[0].billing_evidence.refunded, false);
  assert.equal(postBodies[0].response.success, false);
  assert.equal(await page.getByRole("button").filter({ hasText: "extract-fixture" }).count(), 1, "terminally reconciled record must leave the unresolved list after refresh");

  const screenshot1440 = path.join(evidenceDir, "reconciliation-1440x900.png");
  await page.screenshot({ path: screenshot1440, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "提取任务人工对账" }).waitFor({ state: "visible", timeout: 15_000 });
  const screenshot1920 = path.join(evidenceDir, "reconciliation-1920x1080.png");
  await page.screenshot({ path: screenshot1920, fullPage: true });

  await page.goto(`${baseUrl}/extract`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByText("字幕与文案提取").waitFor({ state: "visible", timeout: 15_000 });
    assert.match(page.url(), /\/tools\?tab=text$/u, "legacy extraction route must resolve to the current toolbox text tab");
  } catch (error) {
    const bodyText = (await page.locator("body").innerText()).slice(-3_000);
    throw new Error(`adjacent extraction page unavailable; url=${page.url()}; body=${bodyText}; cause=${error instanceof Error ? error.message : String(error)}`);
  }
  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "管理后台" }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByRole("link", { name: "提取异常对账" }).waitFor({ state: "visible", timeout: 5_000 });

  assert.deepEqual(unexpectedWrites, [], "zero-cost UI acceptance must not allow unrelated writes");
  assert.deepEqual(pageErrors, [], "the reconciliation and adjacent pages must not throw browser errors");
  const report = {
    passed: true,
    baseUrl,
    buildId: await (await fetch(`${baseUrl}/api/version`)).json().then((value) => value.buildId || value.build_id || null).catch(() => null),
    scenarios: {
      unresolvedList: "PASS",
      evidenceGuidedForm: "PASS",
      explicitTerminalConfirmation: "PASS",
      exactlyOneCommit: "PASS",
      casUpdatedAtForwarded: "PASS",
      providerEvidenceForwarded: "PASS",
      billingEvidenceForwarded: "PASS",
      terminalRecordRemovedAfterReadback: "PASS",
      desktop1440: "PASS",
      desktop1920: "PASS",
      adjacentExtract: "PASS",
      adjacentAdmin: "PASS",
    },
    fixtureCommitRequests: postBodies.length,
    realDatabaseWrites: 0,
    providerCalls: 0,
    paidCalls: 0,
    unexpectedWrites,
    interceptedTelemetryWrites,
    externalRequests,
    pageErrors,
    screenshots: [screenshot1440, screenshot1920],
  };
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
