#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const MODEL_ID = "76b48548-6542-4908-a9f7-10835d2528bb";
const MODEL_NAME = "gpt-6.1-sol";
const DISPLAY_NAME = "GPT-6.1 Sol · LConAI G2";
const PRIMARY_ORIGIN = "https://n.lconai.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/lconai-workbook-onboarding-20261005/gpt61-live-canary-primary-and-activation.json",
);

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

function targetFromInventory(body) {
  const matches = (Array.isArray(body.models) ? body.models : []).filter((model) => (
    model?.model_type === "text"
      && String(model?.id || "") === MODEL_ID
      && String(model?.name || "") === DISPLAY_NAME
  ));
  assert.equal(matches.length, 1, "GPT61_MODEL_COUNT_MISMATCH");
  return matches[0];
}

async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute-paid-canary"), "EXPLICIT_PAID_CANARY_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp && databaseUrl, "LOCAL_ADMIN_STEP_UP_RUNTIME_REQUIRED");
  const parsedDatabaseUrl = new URL(databaseUrl);
  assert.equal(parsedDatabaseUrl.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDatabaseUrl.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDatabaseUrl.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };

  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-lconai-gpt61-primary-canary",
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  await database.connect();
  let stored;
  try {
    const storedResult = await database.query(
      `SELECT id::text,name,model_name,api_endpoint,proxy_url,api_key,is_active,is_hidden,user_access,
              input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,
              api_protocol_config
         FROM public.llm_models
        WHERE id=$1`,
      [MODEL_ID],
    );
    assert.equal(storedResult.rowCount, 1, "GPT61_MODEL_NOT_FOUND");
    stored = storedResult.rows[0];
  } finally {
    await database.end().catch(() => undefined);
  }
  assert.equal(stored.name, DISPLAY_NAME, "GPT61_DISPLAY_NAME_MISMATCH");
  assert.equal(stored.model_name, MODEL_NAME, "GPT61_PROVIDER_MODEL_MISMATCH");
  assert.equal(String(stored.api_endpoint || "").replace(/\/+$/u, ""), PRIMARY_ORIGIN, "GPT61_PRIMARY_ENDPOINT_REQUIRED");
  assert.equal(String(stored.proxy_url || "").replace(/\/+$/u, ""), PRIMARY_ORIGIN, "GPT61_PRIMARY_PROXY_REQUIRED");
  assert.equal(stored.api_key, "secret://lconai-gpt-6-1-sol", "GPT61_CREDENTIAL_REFERENCE_MISMATCH");
  assert.equal(stored.api_protocol_config?.protocol, "openai_chat_completions", "GPT61_PROTOCOL_REQUIRED");
  assert.equal(stored.api_protocol_config?.endpoint_path, "/v1/chat/completions", "GPT61_ENDPOINT_PATH_REQUIRED");
  assert.equal(stored.api_protocol_config?.output_token_field, "max_completion_tokens", "GPT61_OUTPUT_TOKEN_FIELD_REQUIRED");

  const inventory = await requestJson(origin, headers, "/api/admin/models");
  assert.equal(inventory.response.ok, true, `MODEL_INVENTORY_HTTP_${inventory.response.status}`);
  const before = targetFromInventory(inventory.body);
  assert.equal(before.is_hidden, false, "GPT61_VISIBLE_MODEL_REQUIRED");
  assert.ok(
    (before.is_active === true && before.user_access === "available")
      || (before.is_active === false && before.user_access === "pending_model_activation"),
    "GPT61_OPERATIONAL_STATE_INVALID",
  );

  const canary = await requestJson(origin, headers, "/api/admin/llm-test", {
    method: "POST",
    body: JSON.stringify({ model_type: "text", model_id: MODEL_ID }),
    timeout: 90_000,
  });
  const result = {
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
  assert.equal(result.httpStatus, 200, `GPT61_CANARY_HTTP_${result.httpStatus}`);
  assert.equal(result.success, true, "GPT61_CANARY_FAILED");
  assert.equal(result.modelAvailable, true, "GPT61_MODEL_UNAVAILABLE");
  assert.equal(result.paidProbeUsed, true, "GPT61_PAID_PROBE_EVIDENCE_REQUIRED");
  assert.equal(result.evidence?.evidenceRecorded, true, "GPT61_VALIDATION_EVIDENCE_REQUIRED");

  const activation = await requestJson(origin, headers, "/api/admin/models/activate", {
    method: "POST",
    body: JSON.stringify({ id: MODEL_ID, model_type: "text" }),
  });
  assert.equal(activation.response.ok, true, `GPT61_ACTIVATION_HTTP_${activation.response.status}`);
  assert.equal(activation.body.activated, true, "GPT61_ACTIVATION_FAILED");
  assert.equal(activation.body.model?.is_active, true, "GPT61_ACTIVE_FLAG_REQUIRED");
  assert.equal(activation.body.model?.user_access, "available", "GPT61_AVAILABLE_ACCESS_REQUIRED");
  assert.equal(String(activation.body.evidence_id || ""), String(result.evidence.id || ""), "GPT61_ACTIVATION_EVIDENCE_MISMATCH");

  const readback = await requestJson(origin, headers, "/api/admin/models");
  assert.equal(readback.response.ok, true, `GPT61_READBACK_HTTP_${readback.response.status}`);
  const after = targetFromInventory(readback.body);
  assert.equal(after.is_active, true, "GPT61_READBACK_ACTIVE_REQUIRED");
  assert.equal(after.is_hidden, false, "GPT61_READBACK_VISIBLE_REQUIRED");
  assert.equal(after.user_access, "available", "GPT61_READBACK_AVAILABLE_REQUIRED");

  const pricing = {
    inputPerMillion: Number(stored.input_cost_per_million),
    outputPerMillion: Number(stored.output_cost_per_million),
    cachedPerMillion: Number(stored.cached_cost_per_million),
    profitMarginPercent: Number(stored.profit_margin),
  };
  const promptTokens = Number(result.usage?.prompt_tokens || 0);
  const completionTokens = Number(result.usage?.completion_tokens || 0);
  const configuredPriceEstimate = ((promptTokens * pricing.inputPerMillion)
    + (completionTokens * pricing.outputPerMillion)) / 1_000_000;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    modelId: MODEL_ID,
    modelName: MODEL_NAME,
    protocol: "openai_chat_completions",
    endpoint: `${PRIMARY_ORIGIN}/v1/chat/completions`,
    outputTokenField: "max_completion_tokens",
    requestCount: 1,
    retryCount: 0,
    chargedGenerationRequests: 1,
    userWalletDebited: false,
    result,
    activation: {
      activated: true,
      evidenceId: activation.body.evidence_id,
      idempotent: activation.body.idempotent === true,
    },
    pricing,
    configuredPriceEstimate,
    productionWrites: 0,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
