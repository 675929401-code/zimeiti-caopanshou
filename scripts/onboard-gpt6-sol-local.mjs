#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const TARGET_MODEL = "gpt-6-sol";
const TARGET_DISPLAY_NAME = "GPT-6-Sol · 渠道A";
const TARGET_ENDPOINT = "https://token.secure-skill.com/v1";
const evidenceDir = path.resolve(".codex-evidence/gpt6-sol-local-onboarding");

function argumentValue(args, prefix) {
  return String(args.find(value => value.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function assertNoPlaintextCredentials(value, at = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaintextCredentials(item, at + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["api_key", "secret_value", "password", "rawCredential", "resolvedCredential"].includes(key),
      "PLAINTEXT_CREDENTIAL_PROPERTY:" + at + "." + key);
    assertNoPlaintextCredentials(item, at + "." + key);
  }
}

function safeFailureBody(body, credential) {
  const serialized = JSON.stringify(body || {});
  return serialized.replaceAll(credential, "<redacted>").replace(/sk-[A-Za-z0-9_-]+/gu, "<redacted-key>").slice(0, 1200);
}

async function api(origin, token, pathname, options = {}, credential = "") {
  const response = await fetch(origin + pathname, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeout || 60_000),
  });
  const body = await response.json().catch(() => ({}));
  assertNoPlaintextCredentials(body);
  if (!response.ok) {
    throw new Error(pathname + ":HTTP_" + response.status + ":" + safeFailureBody(body, credential));
  }
  return body;
}

async function readCredential(databaseOrigin, serviceRoleKey) {
  const url = new URL("/rest/v1/llm_models", databaseOrigin);
  url.searchParams.set("select", "id,api_endpoint,api_key,model_name,is_active");
  url.searchParams.set("api_endpoint", "ilike.*token.secure-skill.com*");
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("limit", "20");
  const response = await fetch(url, {
    headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const rows = await response.json().catch(() => []);
  assert.ok(response.ok && Array.isArray(rows), "LOCAL_PROVIDER_CREDENTIAL_READ_FAILED");
  const row = rows.find(item => {
    try {
      return new URL(String(item?.api_endpoint || "")).hostname === "token.secure-skill.com"
        && String(item?.api_key || "").trim();
    } catch {
      return false;
    }
  });
  assert.ok(row, "SECURE_SKILL_SERVER_CREDENTIAL_NOT_CONFIGURED");
  return String(row.api_key).trim();
}

async function assertProviderCatalog(credential) {
  const response = await fetch("https://token.secure-skill.com/v1/models", {
    headers: { Authorization: "Bearer " + credential },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, "PROVIDER_CATALOG_HTTP_" + response.status);
  const ids = (Array.isArray(body?.data) ? body.data : [])
    .map(item => String(item?.id || "").trim().toLowerCase())
    .filter(Boolean);
  assert.ok(ids.includes(TARGET_MODEL), "TARGET_MODEL_NOT_IN_AUTHENTICATED_PROVIDER_CATALOG");
  return ids.length;
}

function modelRows(rows) {
  return new Map(rows.map(item => [String(item.id), item.row]));
}

async function readLlmRows(client) {
  const result = await client.query(
    "SELECT id::text AS id, to_jsonb(t) - 'updated_at' AS row FROM public.llm_models t ORDER BY id",
  );
  return result.rows;
}

function assertExistingRowsStable(beforeRows, afterRows) {
  const after = modelRows(afterRows);
  for (const item of beforeRows) {
    assert.ok(after.has(String(item.id)), "EXISTING_LLM_ROW_REMOVED:" + item.id);
    assert.deepEqual(after.get(String(item.id)), item.row, "EXISTING_LLM_CONFIGURATION_CHANGED:" + item.id);
  }
}

function assertPendingTarget(row, credential) {
  assert.ok(row, "TARGET_PHYSICAL_ROW_MISSING");
  assert.equal(String(row.model_name || "").toLowerCase(), TARGET_MODEL);
  assert.equal(String(row.api_endpoint || "").replace(/\/+$/u, ""), TARGET_ENDPOINT);
  assert.equal(row.api_key, credential, "TARGET_SERVER_CREDENTIAL_BINDING_MISMATCH");
  assert.equal(row.is_active, false, "TARGET_MUST_REMAIN_INACTIVE_BEFORE_REAL_VALIDATION");
  assert.equal(row.is_hidden, false);
  assert.equal(row.user_access, "pending_model_activation");
  assert.equal(row.billing_mode, "token");
  assert.equal(row.token_billing_enabled, true);
  assert.equal(Number(row.input_cost_per_million), 0.6);
  assert.equal(Number(row.output_cost_per_million), 3);
  assert.equal(Number(row.cached_cost_per_million), 0.06);
  assert.equal(Number(row.profit_margin), 9.090909);
  assert.equal(Number(row.max_context_tokens), 64000);
}

async function writeReport(report) {
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const databaseOrigin = String(process.env.COZE_SUPABASE_URL || "").replace(/\/+$/u, "");
  const serviceRoleKey = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const maxPaidCalls = Number(argumentValue(args, "--max-paid-calls="));
  const maxBudgetCny = Number(argumentValue(args, "--max-budget-cny="));
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-gpt6-sol"), "LOCAL_GPT6_SOL_CONFIRMATION_REQUIRED");
  assert.equal(maxPaidCalls, 1, "EXACTLY_ONE_PAID_CANARY_REQUIRED");
  assert.ok(Number.isFinite(maxBudgetCny) && maxBudgetCny > 0 && maxBudgetCny <= 5, "MAX_BUDGET_CNY_MUST_BE_WITHIN_5");
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(databaseOrigin, "http://127.0.0.1:54321", "LOCAL_DATABASE_REQUIRED");
  assert.ok(serviceRoleKey && databaseUrl, "LOCAL_DATABASE_CREDENTIALS_REQUIRED");
  const parsedDatabaseUrl = new URL(databaseUrl);
  assert.equal(parsedDatabaseUrl.hostname, "127.0.0.1", "LOCAL_OWNER_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDatabaseUrl.port, "54322", "LOCAL_OWNER_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDatabaseUrl.pathname.replace(/^\//u, ""), "zimeiti_local", "LOCAL_OWNER_DATABASE_NAME_REQUIRED");

  let paidCalls = 0;
  const credential = await readCredential(databaseOrigin, serviceRoleKey);
  const providerCatalogModelCount = await assertProviderCatalog(credential);
  const beforeInventory = await api(origin, token, "/api/admin/models", {}, credential);
  const targetBefore = (Array.isArray(beforeInventory.models) ? beforeInventory.models : [])
    .filter(model => model?.model_type === "text" && String(model?.model_name || "").toLowerCase() === TARGET_MODEL);
  assert.equal(targetBefore.length, 0, "TARGET_ALREADY_EXISTS_ABORTING_NON_IDEMPOTENT_ONBOARDING");

  const poolBefore = await api(origin, token, "/api/admin/model-pool-releases", {}, credential);
  const resumable = (Array.isArray(poolBefore.releases) ? poolBefore.releases : [])
    .filter(release => release?.is_current !== true && ["draft", "validated"].includes(String(release?.status || "")))
    .map(release => ({
      release,
      entry: (Array.isArray(release?.snapshot?.models) ? release.snapshot.models : [])
        .find(model => String(model?.modelName || "").toLowerCase() === TARGET_MODEL
          && model?.configuration?.legacyTable === "llm_models"),
    }))
    .filter(item => item.entry)
    .sort((left, right) => Number(right.release.release_version || 0) - Number(left.release.release_version || 0));
  assert.ok(resumable.length <= 1, "MULTIPLE_UNPUBLISHED_TARGET_CANDIDATES_REQUIRE_REVIEW");
  let staged;
  if (resumable.length === 1) {
    const resumed = resumable[0];
    assert.equal(String(resumed.entry.endpoint || "").replace(/\/+$/u, ""), TARGET_ENDPOINT);
    assert.equal(resumed.entry.catalogState, "enabled");
    assert.equal(resumed.entry.configuration?.userAccess, "pending_model_activation");
    assert.equal(Number(resumed.entry.pricing?.inputCostPerMillion), 0.6);
    assert.equal(Number(resumed.entry.pricing?.outputCostPerMillion), 3);
    assert.equal(Number(resumed.entry.pricing?.cachedCostPerMillion), 0.06);
    staged = { staged: true, published: false, result: {
      release: resumed.release,
      legacyId: resumed.entry.configuration.legacyId,
    } };
  } else staged = await api(origin, token, "/api/admin/models", {
    method: "POST",
    body: JSON.stringify({
      model_type: "text",
      name: TARGET_DISPLAY_NAME,
      description: "GPT-6-Sol 对话模型；渠道A服务端密钥；真实验证通过后开放。",
      category: "通用",
      provider: "secure_skill",
      model_name: TARGET_MODEL,
      api_endpoint: TARGET_ENDPOINT,
      proxy_url: TARGET_ENDPOINT,
      api_key: credential,
      billing_mode: "token",
      token_billing_enabled: true,
      input_cost_per_million: 0.6,
      output_cost_per_million: 3,
      cached_cost_per_million: 0.06,
      profit_margin: 9.090909,
      token_rounding_unit: 0,
      max_context_rounds: 20,
      max_context_tokens: 64000,
      max_reply_tokens: 4096,
      timeout: 120,
      enable_web_search: false,
      deep_thinking_type: 2,
      deduct_deep_think: 1,
      frequency_limit: 50,
      image_parsing: "none",
      file_parsing: "none",
      sort_order: 60,
      admin_notes: "Codex 本地接入；目录发布与运行激活分离；仅接受当前配置真实验证证据。",
    }),
  }, credential);
  assert.equal(staged.staged, true);
  assert.equal(staged.published, false);
  const releaseId = String(staged.result?.release?.id || "");
  const modelId = String(staged.result?.legacyId || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "CANDIDATE_RELEASE_ID_MISSING");
  assert.match(modelId, /^[a-f0-9-]{36}$/iu, "TARGET_MODEL_ID_MISSING");

  const validated = await api(origin, token, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  }, credential);
  assert.equal(validated.release?.status, "validated", "MODEL_POOL_CANDIDATE_NOT_VALIDATED");
  const preview = await api(origin, token,
    "/api/admin/model-pool-releases?previewReleaseId=" + encodeURIComponent(releaseId), {}, credential);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "MODEL_POOL_PREVIEW_HASH_MISSING");

  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-local-gpt6-sol-onboarding",
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  await client.connect();
  let beforeRows;
  try {
    beforeRows = await readLlmRows(client);
    const candidate = await client.query(
      "SELECT snapshot FROM public.model_pool_config_releases WHERE id=$1::uuid AND status IN ('draft','validated')",
      [releaseId],
    );
    assert.equal(candidate.rowCount, 1, "CANDIDATE_SNAPSHOT_NOT_FOUND");
    await client.query("BEGIN");
    try {
      await client.query("SELECT public.project_model_pool_configuration_atomic($1::jsonb)", [
        JSON.stringify(candidate.rows[0].snapshot),
      ]);
      const projectedRows = await readLlmRows(client);
      assertExistingRowsStable(beforeRows, projectedRows);
      const projectedTarget = projectedRows.find(item => item.id === modelId)?.row;
      assertPendingTarget(projectedTarget, credential);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }

  const published = await api(origin, token, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  }, credential);
  assert.equal(String(published.release?.id || ""), releaseId);
  assert.equal(published.release?.status, "published");
  assert.equal(published.release?.is_current, true);

  const readbackClient = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-local-gpt6-sol-readback",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await readbackClient.connect();
  try {
    const afterRows = await readLlmRows(readbackClient);
    assertExistingRowsStable(beforeRows, afterRows);
    assertPendingTarget(afterRows.find(item => item.id === modelId)?.row, credential);
  } finally {
    await readbackClient.end();
  }

  paidCalls += 1;
  const probe = await api(origin, token, "/api/admin/llm-test", {
    method: "POST",
    body: JSON.stringify({ model_type: "text", model_id: modelId }),
    timeout: 60_000,
  }, credential);
  if (probe.success !== true || probe.model_available !== true || !probe.evidence?.id) {
    const failedReport = {
      passed: false,
      checkedAt: new Date().toISOString(),
      targetModel: TARGET_MODEL,
      modelId,
      releaseId,
      modelPublished: true,
      modelActivated: false,
      diagnosticCode: String(probe.diagnosticCode || "UNKNOWN"),
      diagnosticMessage: String(probe.message || "真实验证未通过").slice(0, 500),
      paidCalls,
      automaticRetries: 0,
      maxBudgetCny,
      credentialValuePrinted: false,
      productionWrites: 0,
    };
    await writeReport(failedReport);
    throw new Error("PAID_CANARY_FAILED_NO_RETRY:" + failedReport.diagnosticCode + ":" + failedReport.diagnosticMessage);
  }
  assert.equal(paidCalls, maxPaidCalls, "PAID_CALL_BUDGET_MISMATCH");

  const activated = await api(origin, token, "/api/admin/models/activate", {
    method: "POST",
    body: JSON.stringify({ id: modelId, model_type: "text" }),
  }, credential);
  assert.equal(activated.activated, true);
  assert.equal(activated.model?.is_active, true);
  assert.equal(activated.model?.user_access, "available");
  assert.equal(String(activated.evidence_id || ""), String(probe.evidence.id));

  const finalInventory = await api(origin, token, "/api/admin/models", {}, credential);
  const target = (Array.isArray(finalInventory.models) ? finalInventory.models : [])
    .filter(model => model?.model_type === "text" && String(model?.model_name || "").toLowerCase() === TARGET_MODEL);
  assert.equal(target.length, 1, "TARGET_ADMIN_CATALOG_COUNT_MISMATCH");
  assert.equal(target[0].is_active, true);
  assert.equal(target[0].is_hidden, false);
  assert.equal(target[0].api_key_configured, true);
  assert.equal(target[0].token_billing_enabled, true);

  const publicCatalog = await api(origin, token, "/api/chat-models", {}, credential);
  const publicTarget = (Array.isArray(publicCatalog.models) ? publicCatalog.models : [])
    .filter(model => String(model?.displayName || "").toLowerCase() === TARGET_MODEL);
  assert.equal(publicTarget.length, 1, "TARGET_PUBLIC_CATALOG_COUNT_MISMATCH");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    targetModel: TARGET_MODEL,
    providerHost: "token.secure-skill.com",
    providerCatalogModelCount,
    modelId,
    releaseId,
    releaseVersion: published.release?.release_version,
    exactCandidateProjectionDryRun: true,
    existingLlmRowsPreserved: beforeRows.length,
    realValidation: {
      diagnosticCode: probe.diagnosticCode,
      latencyMs: probe.latency,
      usage: probe.usage,
      evidenceId: probe.evidence.id,
      checkedAt: probe.evidence.checkedAt,
    },
    modelPublished: true,
    modelActivated: true,
    publicCatalogVisible: true,
    paidCalls,
    automaticRetries: 0,
    maxBudgetCny,
    credentialValuePrinted: false,
    productionWrites: 0,
    localDatabaseWrites: true,
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
}
