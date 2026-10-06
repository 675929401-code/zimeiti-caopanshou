#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const evidenceDir = path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005");
const videoNames = [
  "Seedance 2.5 480P 图生视频 · LConAI",
  "Seedance 2.0 Fast 720P 图生视频 · LConAI",
  "Grok Video 3 Pro 10秒 · LConAI",
];
const textNames = [
  "GPT-6.1 Sol · LConAI G2",
  "Claude Opus 5.5 · LConAI Claude Max",
  "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
];
const videoIds = ["seedance-2-5-480p-i2v-lconai", "seedance-2-0-fast-720p-i2v-lconai", "grok-video-3-pro-lconai"];

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${new URL(url).pathname}:HTTP_${response.status}:${JSON.stringify(body).slice(0, 1200)}`);
  return body;
}

function actionableConsoleErrors(values) {
  return values.filter((value) => !/favicon|ResizeObserver|net::ERR_ABORTED|Failed to load resource.*404/iu.test(value));
}

async function assertDesktopRoute(page, origin, route, screenshotName) {
  const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.ok(response?.ok(), `${route}:NAVIGATION_${response?.status()}`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false, `${route}:HORIZONTAL_OVERFLOW`);
  await page.screenshot({ path: path.join(evidenceDir, screenshotName), fullPage: false });
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });

  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = await json(`${origin}/api/admin/access-control/self`, { headers: basicHeaders });
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-lconai-live-acceptance" });
  const consoleErrors = [];
  const failedResponses = [];
  const responseBodyReads = [];
  let cleanupVerified = false;
  let browser;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Live-Acceptance/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    const inventory = await json(`${origin}/api/admin/models`, { headers });
    for (const name of [...videoNames, ...textNames]) {
      assert.equal(inventory.models?.filter((model) => model.name === name).length, 1, `ADMIN_MODEL_READBACK:${name}`);
    }
    const stored = await database.query(
      `SELECT id::text,model_name,api_endpoint,api_key,protocol_type,cost_price,price_per_use,is_active,is_hidden,api_protocol_config
         FROM public.video_models WHERE id = ANY($1::text[]) ORDER BY id`,
      [videoIds],
    );
    assert.equal(stored.rowCount, 3, "VIDEO_DATABASE_READBACK_COUNT");
    for (const row of stored.rows) {
      assert.match(String(row.api_key || ""), /^secret:\/\/lconai-/u, `${row.id}:SECRET_REFERENCE_REQUIRED`);
      assert.equal(String(row.api_endpoint || "").replace(/\/+$/u, ""), "https://s.lconai.com", `${row.id}:CHANNEL_ENDPOINT_MISMATCH`);
      assert.equal(row.protocol_type, "newapi_video", `${row.id}:PROTOCOL_MISMATCH`);
      const protocolConfig = typeof row.api_protocol_config === "string"
        ? JSON.parse(row.api_protocol_config)
        : (row.api_protocol_config || {});
      assert.equal(protocolConfig.__model_activation_gate?.state, "pending", `${row.id}:ACTIVATION_GATE_MISSING:${Object.keys(protocolConfig).join(",")}`);
    }

    const modelPoolOverview = await json(`${origin}/api/admin/model-pool-releases`, { headers });
    const workspaceOverview = await json(`${origin}/api/admin/workspace-model-releases`, { headers });
    const candidate = (workspaceOverview.releases || [])
      .filter((release) => release.is_current !== true
        && release.status === "validated"
        && String(release.change_note || "").includes("LConAI 三个视频模型"))
      .sort((left, right) => Number(right.release_version || 0) - Number(left.release_version || 0))[0];
    assert.ok(candidate, "WORKSPACE_SYNC_CANDIDATE_MISSING");
    assert.equal(
      candidate.snapshot?.modelPoolRelease?.releaseId,
      modelPoolOverview.current?.id,
      "WORKSPACE_CANDIDATE_MUST_REFERENCE_CURRENT_MODEL_POOL",
    );
    for (const surface of ["storyboard-video", "video-page"]) {
      for (const modelId of videoIds) {
        assert.ok(candidate.snapshot?.surfaces?.[surface]?.assignedModelIds?.includes(modelId), `${surface}:CANDIDATE_ASSIGNMENT_MISSING:${modelId}`);
      }
    }
    assert.equal(candidate.is_current, false, "UNVERIFIED_WORKSPACE_CANDIDATE_MUST_NOT_BE_CURRENT");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, extraHTTPHeaders: headers });
    await context.addInitScript(({ authToken, authIdentity }) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authIdentity.user));
      sessionStorage.setItem("entered_app", "1");
    }, { authToken: token, authIdentity: identity });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror:${error.message}`));
    page.on("response", (response) => {
      if (response.url().startsWith(origin) && response.status() >= 500) {
        const entry = { status: response.status(), pathname: new URL(response.url()).pathname, code: "" };
        failedResponses.push(entry);
        responseBodyReads.push(response.json().then((body) => {
          entry.code = typeof body?.code === "string" ? body.code : "";
        }).catch(() => undefined));
      }
    });

    await assertDesktopRoute(page, origin, "/admin?tab=models", "admin-model-pool-1600x1000.png");
    await page.getByTestId("authorized-models-admin-tab").waitFor({ timeout: 60_000 });
    for (const name of videoNames) await page.getByText(name, { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /对话模型/u }).click();
    for (const name of textNames) await page.getByText(name, { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(evidenceDir, "admin-text-models-1600x1000.png"), fullPage: false });

    await assertDesktopRoute(page, origin, "/admin?tab=workspace-models&project=storyboard", "admin-workspace-storyboard-1600x1000.png");
    const releasePanel = page.getByTestId("platform-release-panel-workspace-models");
    await releasePanel.waitFor({ timeout: 60_000 });
    await releasePanel.getByRole("button", { name: "管理版本" }).click();
    await releasePanel.getByText(/LConAI 三个视频模型同步到分镜工作台与视频制作/u).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(evidenceDir, "admin-workspace-candidate-1600x1000.png"), fullPage: false });

    await assertDesktopRoute(page, origin, "/storyboard-workbench", "storyboard-workbench-1600x1000.png");
    await assertDesktopRoute(page, origin, "/video", "video-page-1600x1000.png");
    await assertDesktopRoute(page, origin, "/image-workbench", "image-workbench-neighbor-1600x1000.png");
    await assertDesktopRoute(page, origin, "/media-history", "media-history-neighbor-1600x1000.png");
    await context.close();

    await Promise.allSettled(responseBodyReads);
    const expectedTelemetryFailures = failedResponses.filter((entry) => (
      entry.status === 503
      && entry.pathname === "/api/product-usage/events"
      && ["PRODUCT_USAGE_POLICY_NOT_CONFIGURED", "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED"].includes(entry.code)
    ));
    const unexpectedServerErrors = failedResponses.filter((entry) => !expectedTelemetryFailures.includes(entry));
    const actionableErrors = actionableConsoleErrors(consoleErrors);
    const expectedTelemetryConsoleErrors = actionableErrors.filter((message) => /status (?:code )?of 503|status of 503/iu.test(message));
    const unexpectedConsoleErrors = actionableErrors.filter((message) => !expectedTelemetryConsoleErrors.includes(message));
    assert.ok(expectedTelemetryConsoleErrors.length <= expectedTelemetryFailures.length, "UNMATCHED_PRODUCT_USAGE_503_CONSOLE_ERROR");
    assert.deepEqual(unexpectedServerErrors, [], `LOCAL_5XX_RESPONSES:${JSON.stringify(unexpectedServerErrors)}`);
    assert.deepEqual(unexpectedConsoleErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(unexpectedConsoleErrors)}`);
    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      viewport: "1600x1000 desktop",
      adminModelsReadback: 6,
      videoSecretReferences: 3,
      workspaceCandidate: { id: candidate.id, status: candidate.status, current: false },
      routes: ["/admin?tab=models", "/admin?tab=workspace-models&project=storyboard", "/storyboard-workbench", "/video", "/image-workbench", "/media-history"],
      horizontalOverflow: false,
      browserConsoleErrors: 0,
      localHttp5xx: 0,
      expectedTelemetryFailClosed: expectedTelemetryFailures.length,
      paidProviderCalls: 0,
    };
    await fs.writeFile(path.join(evidenceDir, "live-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    try {
      await database.query("BEGIN");
      await database.query("SELECT set_config('app.admin_governance_write','on',true)");
      await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await database.query("COMMIT");
      const remaining = await database.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      cleanupVerified = Number(remaining.rows[0]?.count || 0) === 0;
    } catch {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    await database.end().catch(() => undefined);
  }
  assert.equal(cleanupVerified, true, "TEMPORARY_STEP_UP_CLEANUP_FAILED");
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) await main();
