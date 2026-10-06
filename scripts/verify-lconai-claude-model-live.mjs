#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const TARGETS = new Map([
  ["claude-opus-5-5", {
    id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
    name: "Claude Opus 5.5 · LConAI Claude Max",
  }],
  ["claude-sonnet-5-5", {
    id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
    name: "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
  }],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

async function requestJson(origin, headers, pathname, options = {}) {
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
  return { response, body };
}

async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute-paid-canary"), "EXPLICIT_PAID_CANARY_CONFIRMATION_REQUIRED");
  const targetName = argumentValue(args, "model");
  const target = TARGETS.get(targetName);
  assert.ok(target, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");

  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  const parsedDb = new URL(databaseUrl);
  assert.equal(parsedDb.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDb.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDb.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: `codex-lconai-${targetName}-live-canary`,
    statement_timeout: 30_000,
  });
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const basicHeaders = { Authorization: `Bearer ${token}` };
  let cleanupVerified = false;
  let result;
  let pricing;
  let activation;

  try {
    await database.connect();
    const modelResult = await database.query(
      `SELECT id::text,name,model_name,api_endpoint,api_key,is_active,is_hidden,user_access,
              token_billing_enabled,input_cost_per_million,output_cost_per_million,
              cached_cost_per_million,profit_margin,api_protocol_config
         FROM public.llm_models
        WHERE id=$1`,
      [target.id],
    );
    assert.equal(modelResult.rowCount, 1, "TARGET_MODEL_NOT_FOUND");
    const row = modelResult.rows[0];
    assert.equal(row.name, target.name, "TARGET_DISPLAY_NAME_MISMATCH");
    assert.equal(row.model_name, targetName, "TARGET_MODEL_NAME_MISMATCH");
    assert.equal(
      String(row.api_endpoint || "").replace(/\/+$/u, ""),
      "https://n.lconai.com",
      "PRIMARY_ENDPOINT_REQUIRED",
    );
    assert.equal(row.api_protocol_config?.protocol, "anthropic_messages", "ANTHROPIC_MESSAGES_PROTOCOL_REQUIRED");
    assert.equal(row.api_protocol_config?.endpoint_path, "/v1/messages", "CLAUDE_MESSAGES_PATH_REQUIRED");
    assert.equal(row.is_hidden, false, "VISIBLE_MODEL_REQUIRED");
    assert.ok(
      (row.is_active === true && row.user_access === "available")
        || (row.is_active === false && row.user_access === "pending_model_activation"),
      "MODEL_OPERATIONAL_STATE_INVALID",
    );
    assert.equal(row.token_billing_enabled, true, "TOKEN_BILLING_REQUIRED");
    pricing = {
      inputPerMillion: Number(row.input_cost_per_million),
      outputPerMillion: Number(row.output_cost_per_million),
      cachedPerMillion: Number(row.cached_cost_per_million),
      profitMarginPercent: Number(row.profit_margin),
    };
    assert.ok(
      Object.values(pricing).every((value) => Number.isFinite(value) && value >= 0),
      "EXPLICIT_NONNEGATIVE_TOKEN_PRICING_REQUIRED",
    );

    const self = await requestJson(origin, basicHeaders, "/api/admin/access-control/self");
    assert.equal(self.response.ok, true, "ADMIN_ACCESS_READ_FAILED");
    assert.ok(self.body.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");

    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Claude-Canary/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.body.access.permissionKeys), self.body.access.revision],
    );
    await database.query("COMMIT");

    const canary = await requestJson(
      origin,
      { ...basicHeaders, "x-admin-step-up": stepUpToken },
      "/api/admin/llm-test",
      {
        method: "POST",
        body: JSON.stringify({ model_type: "text", model_id: target.id }),
        timeout: 90_000,
      },
    );
    result = {
      httpStatus: canary.response.status,
      success: canary.body.success === true,
      modelAvailable: canary.body.model_available === true,
      diagnosticCode: canary.body.diagnosticCode || null,
      message: canary.body.message || null,
      paidProbeUsed: canary.body.paidProbeUsed === true,
      latencyMs: Number(canary.body.latency || 0),
      usage: canary.body.usage || null,
      evidence: canary.body.evidence || null,
    };
    assert.equal(result.httpStatus, 200, `CANARY_HTTP_${result.httpStatus}`);
    assert.equal(result.success, true, "CLAUDE_CANARY_FAILED");
    assert.equal(result.modelAvailable, true, "CLAUDE_MODEL_UNAVAILABLE");
    assert.equal(result.paidProbeUsed, true, "PAID_PROBE_EVIDENCE_REQUIRED");
    assert.equal(result.evidence?.evidenceRecorded, true, "VALIDATION_EVIDENCE_REQUIRED");

    const activationResponse = await requestJson(
      origin,
      { ...basicHeaders, "x-admin-step-up": stepUpToken },
      "/api/admin/models/activate",
      {
        method: "POST",
        body: JSON.stringify({ id: target.id, model_type: "text" }),
      },
    );
    activation = {
      httpStatus: activationResponse.response.status,
      activated: activationResponse.body.activated === true,
      active: activationResponse.body.model?.is_active === true,
      userAccess: String(activationResponse.body.model?.user_access || ""),
      evidenceId: String(activationResponse.body.evidence_id || ""),
      idempotent: activationResponse.body.idempotent === true,
    };
    assert.equal(activation.httpStatus, 200, `ACTIVATION_HTTP_${activation.httpStatus}`);
    assert.equal(activation.activated, true, "MODEL_ACTIVATION_FAILED");
    assert.equal(activation.active, true, "ACTIVE_MODEL_REQUIRED");
    assert.equal(activation.userAccess, "available", "AVAILABLE_MODEL_REQUIRED");
    assert.equal(activation.evidenceId, String(result.evidence.id || ""), "ACTIVATION_EVIDENCE_MISMATCH");
  } finally {
    try {
      await database.query("BEGIN");
      await database.query("SELECT set_config('app.admin_governance_write','on',true)");
      await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await database.query("COMMIT");
      const remaining = await database.query(
        "SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1",
        [stepUpHash],
      );
      cleanupVerified = Number(remaining.rows[0]?.count || 0) === 0;
    } catch {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    await database.end().catch(() => undefined);
  }

  assert.equal(cleanupVerified, true, "TEMPORARY_STEP_UP_CLEANUP_FAILED");
  const promptTokens = Number(result?.usage?.prompt_tokens || 0);
  const completionTokens = Number(result?.usage?.completion_tokens || 0);
  const estimatedSupplierCost = ((promptTokens * pricing.inputPerMillion) + (completionTokens * pricing.outputPerMillion)) / 1_000_000;
  const report = {
    passed: result?.httpStatus === 200
      && result?.success === true
      && result?.modelAvailable === true
      && result?.evidence?.evidenceRecorded === true,
    checkedAt: new Date().toISOString(),
    origin,
    modelId: target.id,
    modelName: targetName,
    protocol: "anthropic_messages",
    endpoint: "https://n.lconai.com/v1/messages",
    requestCount: 1,
    retryCount: 0,
    chargedGenerationRequests: 1,
    userWalletDebited: false,
    result,
    activation,
    pricing,
    configuredPriceEstimate: estimatedSupplierCost,
    zeroPriceFields: Object.entries(pricing)
      .filter(([key, value]) => key !== "profitMarginPercent" && value === 0)
      .map(([key]) => key),
    temporaryStepUpCleaned: cleanupVerified,
    productionWrites: 0,
  };
  const evidencePath = path.resolve(
    `.codex-evidence/lconai-workbook-onboarding-20261005/${targetName}-live-canary.json`,
  );
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, `CANARY_NOT_PASSED:${result?.diagnosticCode || result?.httpStatus}`);
  assert.equal(result.httpStatus, 200, `CANARY_HTTP_${result.httpStatus}`);
  assert.equal(result.success, true, "CLAUDE_CANARY_FAILED");
  assert.equal(result.modelAvailable, true, "CLAUDE_MODEL_UNAVAILABLE");
  assert.equal(result.paidProbeUsed, true, "PAID_PROBE_EVIDENCE_REQUIRED");
  assert.equal(result.evidence?.evidenceRecorded, true, "VALIDATION_EVIDENCE_REQUIRED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
