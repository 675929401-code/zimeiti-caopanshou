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
const outputDir = path.resolve(".codex-evidence", "operation-flight-recorder", "live");

function api(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  assert.ok(process.env.DATABASE_URL, "LOCAL_DATABASE_URL_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(outputDir, { recursive: true });

  const traceId = `flight-live-${crypto.randomUUID()}`;
  const recordId = crypto.createHash("sha256").update(traceId).digest("hex");
  const payloadFingerprint = crypto.createHash("sha256").update(`${traceId}:payload`).digest("hex");
  const eventId = crypto.randomUUID();
  const fakeCredential = "Bearer fixture-flight-secret-value";
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "codex-flight-recorder-live" });
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    traceId,
    sourceVersion: null,
    buildId: null,
    api: {},
    database: {},
    viewports: [],
    adjacentPages: [],
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    browserWrites: [],
    paidRequests: [],
    externalBrowserRequests: [],
    cleanup: {},
  };

  await db.connect();
  let fixtureCommitted = false;
  let browser;
  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO public.extraction_attempts(record_id,user_id,client_request_id,request_kind,payload_fingerprint,state)
       VALUES($1,$2,$3,'single',$4,'running')`,
      [recordId, identity.user.id, traceId, payloadFingerprint],
    );
    await db.query(
      `UPDATE public.extraction_attempts
          SET state='failed',http_status=502,response='{"error":"fixture"}'::jsonb,error_code='FIXTURE_UPSTREAM',error_message='fixture-only',updated_at=now()
        WHERE record_id=$1`,
      [recordId],
    );
    await db.query("COMMIT");
    fixtureCommitted = true;

    const unauthenticated = await fetch(`${origin}/api/admin/operation-events`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(unauthenticated.status, 401, "ADMIN_FLIGHT_API_MUST_REQUIRE_AUTH");
    report.api.unauthenticatedStatus = unauthenticated.status;

    const telemetry = await api("/api/operation-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: eventId,
        trace_id: traceId,
        domain: "extract",
        operation: "extract.request",
        phase: "response",
        outcome: "error",
        duration_ms: 842,
        http_status: 502,
        route: "/api/extract?token=fixture-query-secret",
        error_code: "HTTP_502",
        summary: `${fakeCredential} token=https://fixture.invalid/?token=fixture-query-secret`,
        metadata: {
          method: "POST",
          transport: "fetch",
          response_kind: "json",
          page_path: "/admin?tab=health&token=fixture-page-secret",
          client_started_at: new Date(Date.now() - 842).toISOString(),
        },
        occurred_at: new Date().toISOString(),
      }),
    });
    const telemetryBody = await telemetry.json();
    assert.equal(telemetry.status, 201, JSON.stringify(telemetryBody));
    assert.equal(telemetryBody.accepted, true);
    report.api.telemetryStatus = telemetry.status;

    const listResponse = await api(`/api/admin/operation-events?traceId=${encodeURIComponent(traceId)}&pageSize=30`);
    const list = await listResponse.json();
    assert.ok(listResponse.ok, JSON.stringify(list));
    assert.equal(list.data.length, 3, "BROWSER_AND_DATABASE_TIMELINE_MUST_MERGE");
    assert.deepEqual(list.data.map((event) => event.source).sort(), ["browser", "database", "database"]);
    assert.ok(list.data.every((event) => !JSON.stringify(event).includes("fixture-flight-secret-value")), "LIST_LEAKED_CREDENTIAL");
    report.api.mergedEvents = list.data.length;

    const traceResponse = await api(`/api/admin/operation-events/${encodeURIComponent(traceId)}`);
    const trace = await traceResponse.json();
    assert.ok(traceResponse.ok, JSON.stringify(trace));
    assert.equal(trace.events.length, 3);
    assert.equal(trace.analysis.automaticRepairEligible, false);
    assert.equal(trace.codexBundle.recoveryPolicy.serverDirectCodeMutation, false);
    assert.equal(trace.codexBundle.recoveryPolicy.paidRequestAutoReplay, false);
    const bundleText = JSON.stringify(trace.codexBundle);
    for (const forbidden of ["fixture-flight-secret-value", "fixture-query-secret", "fixture-page-secret"]) {
      assert.equal(bundleText.includes(forbidden), false, `CODEX_BUNDLE_LEAKED:${forbidden}`);
    }
    assert.match(trace.codexBundle.userRef, /^usr_[a-f0-9]{12}$/u);
    report.api.bundleSanitized = true;

    const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(10_000) });
    const version = await versionResponse.json();
    assert.ok(versionResponse.ok && version.sourceVersion && version.buildId, "RUNTIME_IDENTITY_REQUIRED");
    report.sourceVersion = version.sourceVersion;
    report.buildId = version.buildId;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
    });
    page.on("response", (response) => {
      if (response.status() >= 500) report.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) report.externalBrowserRequests.push(url.origin);
      if (request.method() !== "GET" && request.method() !== "HEAD") report.browserWrites.push(`${request.method()} ${url.pathname}`);
      if (/^\/api\/(?:llm|image\/generate|video\/generate|voice\/tts|payment\/create)$/u.test(url.pathname)) report.paidRequests.push(`${request.method()} ${url.pathname}`);
    });

    await page.goto(`${origin}/admin?tab=health`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("operation-flight-recorder").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByText("运行飞行日志", { exact: true }).waitFor({ state: "visible" });
    await page.getByTitle(traceId).first().waitFor({ state: "visible", timeout: 30_000 });
    const overflow1440 = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(overflow1440.scrollWidth <= overflow1440.viewport + 1, `HEALTH_1440_OVERFLOW:${JSON.stringify(overflow1440)}`);
    await page.screenshot({ path: path.join(outputDir, "health-flight-1440x900.png"), fullPage: true });
    report.viewports.push({ width: 1440, height: 900, ...overflow1440 });

    await page.getByTitle(traceId).first().click();
    await page.getByTestId("operation-trace-dialog").waitFor({ state: "visible" });
    await page.getByText("Trace 完整时间线", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("线上自动改代码：关闭 · 付费任务自动重放：关闭", { exact: true }).waitFor({ state: "visible" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出脱敏 Codex 问题包", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert.ok(downloadPath, "CODEX_BUNDLE_DOWNLOAD_PATH_REQUIRED");
    const downloadedBundle = JSON.parse(await fs.readFile(downloadPath, "utf8"));
    assert.equal(downloadedBundle.traceId, traceId);
    assert.equal(downloadedBundle.recoveryPolicy.serverDirectCodeMutation, false);
    assert.equal(JSON.stringify(downloadedBundle).includes("fixture-flight-secret-value"), false);
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    await page.setViewportSize({ width: 1920, height: 1080 });
    const overflow1920 = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(overflow1920.scrollWidth <= overflow1920.viewport + 1, `HEALTH_1920_OVERFLOW:${JSON.stringify(overflow1920)}`);
    await page.screenshot({ path: path.join(outputDir, "health-flight-1920x1080.png"), fullPage: true });
    report.viewports.push({ width: 1920, height: 1080, ...overflow1920 });

    for (const adjacent of [
      { tab: "dashboard", text: "平台指挥中心" },
      { tab: "security", text: "安全审计" },
    ]) {
      await page.goto(`${origin}/admin?tab=${adjacent.tab}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("navigation", { name: "管理后台功能导航" }).getByRole("button", { name: adjacent.text, exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      const overflow = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(overflow.scrollWidth <= overflow.viewport + 1, `ADJACENT_OVERFLOW:${adjacent.tab}`);
      report.adjacentPages.push({ ...adjacent, overflow });
    }
    await context.close();

    report.database = {
      lifecycleEvents: list.data.filter((event) => event.source === "database").length,
      browserEvents: list.data.filter((event) => event.source === "browser").length,
      phases: list.data.map((event) => event.phase).sort(),
    };
    assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
    assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
    assert.deepEqual(report.httpErrors, [], "BROWSER_HTTP_5XX");
    assert.deepEqual(report.paidRequests, [], "PAID_REQUEST_DETECTED");
    assert.deepEqual([...new Set(report.externalBrowserRequests)], [], "EXTERNAL_BROWSER_REQUEST_DETECTED");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (fixtureCommitted) {
      await db.query("BEGIN").catch(() => undefined);
      try {
        await db.query("DELETE FROM public.operation_flight_events WHERE trace_id=$1", [traceId]);
        await db.query("DELETE FROM public.extraction_attempts WHERE record_id=$1", [recordId]);
        await db.query("DELETE FROM public.diagnostic_logs WHERE context @> $1::jsonb", [JSON.stringify({ trace_id: traceId })]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::integer FROM public.operation_flight_events WHERE trace_id=$1) AS events,
         (SELECT count(*)::integer FROM public.extraction_attempts WHERE record_id=$2) AS attempts`,
      [traceId, recordId],
    ).catch(() => ({ rows: [{ events: -1, attempts: -1 }] }));
    report.cleanup = residue.rows[0];
    await db.end();
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  assert.deepEqual(report.cleanup, { events: 0, attempts: 0 }, "LIVE_FIXTURE_RESIDUE");
  console.log(JSON.stringify({ passed: true, ...report }, null, 2));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
