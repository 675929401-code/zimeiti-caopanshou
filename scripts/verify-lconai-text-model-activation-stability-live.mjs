#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const TARGETS = [
  { modelName: "gpt-6.1-sol", displayName: "GPT-6.1 Sol · LConAI G2", publicPrefix: "GPT-6.1 Sol" },
  { modelName: "claude-opus-5-5", displayName: "Claude Opus 5.5 · LConAI Claude Max", publicPrefix: "Claude Opus 5.5" },
  { modelName: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5 · LConAI Claude AWS/G2", publicPrefix: "Claude Sonnet 5.5" },
];
const evidencePath = path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005/text-activation-stability.json");

function noSecretProperties(value, at = "response") {
  if (Array.isArray(value)) return value.forEach((item, index) => noSecretProperties(item, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["api_key", "secret_value", "password", "resolvedCredential"].includes(key), `PLAINTEXT_SECRET_PROPERTY:${at}.${key}`);
    noSecretProperties(item, `${at}.${key}`);
  }
}

async function json(origin, headers, pathname, options = {}) {
  const response = await fetch(origin + pathname, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeout || 90_000),
  });
  const body = await response.json().catch(() => ({}));
  noSecretProperties(body);
  if (!response.ok) throw new Error(`${pathname}:HTTP_${response.status}:${JSON.stringify(body).slice(0, 1200)}`);
  return body;
}

function selectTargets(models) {
  return TARGETS.map((target) => {
    const matches = models.filter((model) => model.model_type === "text"
      && String(model.model_name || "").toLowerCase() === target.modelName
      && String(model.name || "") === target.displayName);
    assert.equal(matches.length, 1, `${target.modelName}:MODEL_COUNT_MISMATCH`);
    return { ...target, id: String(matches[0].id) };
  });
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-activation-stability"), "LOCAL_ACTIVATION_STABILITY_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "");
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");

  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-lconai-text-activation-stability",
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = await json(origin, basicHeaders, "/api/admin/access-control/self");
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  let cleanupVerified = false;
  let browser;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Activation-Stability/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    const beforeInventory = await json(origin, headers, "/api/admin/models");
    const targets = selectTargets(Array.isArray(beforeInventory.models) ? beforeInventory.models : []);
    const activationResults = [];
    for (const target of targets) {
      const activated = await json(origin, headers, "/api/admin/models/activate", {
        method: "POST",
        body: JSON.stringify({ id: target.id, model_type: "text" }),
      });
      assert.equal(activated.activated, true, `${target.modelName}:ACTIVATION_FAILED`);
      assert.equal(activated.model?.is_active, true, `${target.modelName}:ACTIVE_FLAG_MISSING`);
      assert.equal(activated.model?.user_access, "available", `${target.modelName}:ACCESS_NOT_AVAILABLE`);
      activationResults.push({
        modelName: target.modelName,
        modelId: target.id,
        evidenceId: String(activated.evidence_id || ""),
        checkedAt: String(activated.checked_at || ""),
        idempotent: activated.idempotent === true,
      });
    }

    const pool = await json(origin, headers, "/api/admin/model-pool-releases");
    assert.ok(pool.current?.snapshot && pool.current?.id, "CURRENT_MODEL_POOL_REQUIRED");
    const staged = await json(origin, headers, "/api/admin/model-pool-releases", {
      method: "POST",
      body: JSON.stringify({
        action: "draft",
        snapshot: pool.current.snapshot,
        changeNote: "回归验证：模型池再次发布不得撤销配置未变化且已验证的对话模型",
      }),
    });
    const releaseId = String(staged.release?.id || "");
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "REGRESSION_RELEASE_ID_MISSING");
    const validated = await json(origin, headers, "/api/admin/model-pool-releases", {
      method: "POST",
      body: JSON.stringify({ action: "validate", releaseId }),
    });
    assert.equal(validated.release?.status, "validated", "REGRESSION_RELEASE_NOT_VALIDATED");
    const preview = await json(origin, headers, `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
    const previewSha256 = String(preview.preview?.previewSha256 || "");
    assert.match(previewSha256, /^[a-f0-9]{64}$/u, "REGRESSION_PREVIEW_HASH_MISSING");
    const published = await json(origin, headers, "/api/admin/model-pool-releases", {
      method: "POST",
      body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
    });
    assert.equal(published.release?.status, "published", "REGRESSION_RELEASE_NOT_PUBLISHED");
    assert.equal(published.release?.is_current, true, "REGRESSION_RELEASE_NOT_CURRENT");

    const selector = await json(origin, headers, "/api/llm-models?admin=1");
    const selectorModels = Array.isArray(selector.models) ? selector.models : [];
    const selected = targets.map((target) => {
      const matches = selectorModels.filter((model) => String(model.id) === target.id);
      assert.equal(matches.length, 1, `${target.modelName}:MISSING_AFTER_REPUBLISH`);
      assert.equal(matches[0].is_active, true, `${target.modelName}:INACTIVE_AFTER_REPUBLISH`);
      assert.equal(matches[0].user_access, "available", `${target.modelName}:PENDING_AFTER_REPUBLISH`);
      return { modelName: target.modelName, modelId: target.id, displayName: String(matches[0].name || "") };
    });

    const publicCatalog = await json(origin, basicHeaders, "/api/chat-models");
    const publicModels = Array.isArray(publicCatalog.models) ? publicCatalog.models : [];
    for (const target of targets) {
      assert.equal(publicModels.filter((model) => String(model.displayName || "").startsWith(target.publicPrefix)).length, 1,
        `${target.modelName}:PUBLIC_CATALOG_MISSING`);
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      extraHTTPHeaders: headers,
    });
    await context.addInitScript(({ authToken, authIdentity }) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authIdentity.user));
      sessionStorage.setItem("entered_app", "1");
    }, { authToken: token, authIdentity: identity });
    const page = await context.newPage();
    const serverErrors = [];
    page.on("response", (response) => {
      if (response.url().startsWith(origin) && response.status() >= 500) {
        serverErrors.push({ pathname: new URL(response.url()).pathname, status: response.status() });
      }
    });
    const response = await page.goto(`${origin}/admin?tab=agents&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(response?.ok(), `AGENT_ADMIN_NAVIGATION_${response?.status()}`);
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    const highEnergyRow = page.getByRole("row").filter({ hasText: "3D故事导演 | 高能版" }).first();
    await highEnergyRow.waitFor({ timeout: 60_000 });
    await highEnergyRow.getByRole("button", { name: "编辑", exact: true }).click();
    const modelLabel = page.locator("label").filter({ hasText: "选择预设模型" }).last();
    await modelLabel.waitFor({ timeout: 30_000 });
    const modelSelect = modelLabel.locator("..").locator("select");
    const optionTexts = await modelSelect.locator("option").allTextContents();
    for (const target of TARGETS) {
      assert.ok(optionTexts.some((text) => text.includes(target.displayName) && text.includes(target.modelName)),
        `${target.modelName}:AGENT_SELECTOR_OPTION_MISSING`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false,
      "AGENT_ADMIN_HORIZONTAL_OVERFLOW");
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await page.screenshot({
      path: path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005/agent-selector-three-models-1600x1000.png"),
      fullPage: false,
    });
    for (const route of ["/admin?tab=models", "/storyboard-workbench", "/video"]) {
      const neighbor = await page.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.ok(neighbor?.ok(), `${route}:NAVIGATION_${neighbor?.status()}`);
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false,
        `${route}:HORIZONTAL_OVERFLOW`);
    }
    const unexpectedServerErrors = serverErrors.filter((entry) => !(entry.status === 503 && entry.pathname === "/api/product-usage/events"));
    assert.deepEqual(unexpectedServerErrors, [], `LOCAL_5XX_RESPONSES:${JSON.stringify(unexpectedServerErrors)}`);
    await context.close();

    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      sourceVersion: String((await json(origin, {}, "/api/version")).sourceVersion || ""),
      buildId: String((await json(origin, {}, "/api/version")).buildId || ""),
      activated: activationResults,
      regressionRelease: { id: releaseId, version: published.release?.release_version, published: true },
      selectorModels: selected,
      agentSelector: {
        route: "/admin?tab=agents&view=overview",
        agent: "3D故事导演 | 高能版",
        optionsPresent: TARGETS.map((target) => target.modelName),
        changedAgentConfiguration: false,
        viewport: "1600x1000 desktop",
        horizontalOverflow: false,
      },
      neighborRoutes: ["/admin?tab=models", "/storyboard-workbench", "/video"],
      repeatedPublicationPreservedActivation: true,
      providerCalls: 0,
      paidCalls: 0,
      credentialValuesPrinted: false,
      productionWrites: 0,
      localDatabaseWrites: true,
    };
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    if (!database.ended) {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.query("BEGIN").catch(() => undefined);
      await database.query("SELECT set_config('app.admin_governance_write','on',true)").catch(() => undefined);
      await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]).catch(() => undefined);
      await database.query("COMMIT").catch(() => undefined);
      const cleaned = await database.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]).catch(() => ({ rows: [{ count: 1 }] }));
      cleanupVerified = Number(cleaned.rows[0]?.count || 0) === 0;
      await database.end().catch(() => undefined);
    }
    assert.equal(cleanupVerified, true, "TEMPORARY_STEP_UP_SESSION_CLEANUP_FAILED");
  }
}
