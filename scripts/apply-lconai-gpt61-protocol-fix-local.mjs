#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const MODEL_ID = "76b48548-6542-4908-a9f7-10835d2528bb";
const MODEL_NAME = "GPT-6.1 Sol · LConAI G2";
const PROVIDER_MODEL = "gpt-6.1-sol";
const SECRET_REF = "secret://lconai-gpt-6-1-sol";
const PRIMARY_ORIGIN = "https://n.lconai.com";
const BACKUP_ORIGIN = "https://s.lconai.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/lconai-workbook-onboarding-20261005/gpt61-protocol-config-update.json",
);

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function safeBinding(row) {
  return {
    id: row.id,
    name: row.name,
    modelName: row.model_name,
    apiEndpoint: normalizeOrigin(row.api_endpoint),
    proxyUrl: normalizeOrigin(row.proxy_url),
    apiKeyRef: row.api_key === SECRET_REF ? SECRET_REF : "[unexpected-secret-reference-redacted]",
    deepThinkingType: Number(row.deep_thinking_type),
    deductDeepThink: Number(row.deduct_deep_think),
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    userAccess: row.user_access,
    maxReplyTokens: Number(row.max_reply_tokens),
    maxContextTokens: Number(row.max_context_tokens),
    timeoutSeconds: Number(row.timeout),
    protocolConfig: row.api_protocol_config || {},
    adminNotes: row.admin_notes || "",
  };
}

function protectedBinding(row) {
  return {
    apiKey: row.api_key,
    active: row.is_active,
    hidden: row.is_hidden,
    userAccess: row.user_access,
    billingMode: row.billing_mode,
    tokenBillingEnabled: row.token_billing_enabled,
    inputCostPerMillion: String(row.input_cost_per_million),
    outputCostPerMillion: String(row.output_cost_per_million),
    cachedCostPerMillion: String(row.cached_cost_per_million),
    profitMargin: String(row.profit_margin),
    maxContextTokens: row.max_context_tokens,
    maxReplyTokens: row.max_reply_tokens,
    timeout: row.timeout,
  };
}

const selection = `
  SELECT id,name,model_name,api_endpoint,proxy_url,api_key,
         billing_mode,token_billing_enabled,input_cost_per_million,
         output_cost_per_million,cached_cost_per_million,profit_margin,
         deep_thinking_type,deduct_deep_think,is_active,is_hidden,user_access,
         api_protocol_config,admin_notes,max_reply_tokens,max_context_tokens,timeout
    FROM public.llm_models
   WHERE id=$1
`;

async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-gpt61-protocol"), "LOCAL_GPT61_PROTOCOL_CONFIRMATION_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-lconai-gpt61-protocol-fix-local",
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });

  let before;
  let after;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");

    const locked = await database.query(`${selection} FOR UPDATE`, [MODEL_ID]);
    assert.equal(locked.rowCount, 1, "GPT61_MODEL_NOT_FOUND");
    before = locked.rows[0];
    assert.equal(before.name, MODEL_NAME, "GPT61_DISPLAY_NAME_MISMATCH");
    assert.equal(before.model_name, PROVIDER_MODEL, "GPT61_PROVIDER_MODEL_MISMATCH");
    assert.ok(
      [PRIMARY_ORIGIN, BACKUP_ORIGIN].includes(normalizeOrigin(before.api_endpoint)),
      "GPT61_LCONAI_ENDPOINT_REQUIRED",
    );
    assert.ok(
      [PRIMARY_ORIGIN, BACKUP_ORIGIN].includes(normalizeOrigin(before.proxy_url)),
      "GPT61_LCONAI_PROXY_REQUIRED",
    );
    assert.equal(before.api_key, SECRET_REF, "GPT61_SECRET_REFERENCE_MISMATCH");
    assert.equal(before.is_hidden, false, "GPT61_VISIBILITY_MUST_BE_PRESERVED");
    assert.ok(
      (before.is_active === true && before.user_access === "available")
        || (before.is_active === false && before.user_access === "pending_model_activation"),
      "GPT61_OPERATIONAL_STATE_MUST_BE_AVAILABLE_OR_VALIDATION_PENDING",
    );

    const nextProtocolConfig = {
      ...(before.api_protocol_config || {}),
      channel: "lconai",
      connection_group: "G2",
      protocol: "openai_chat_completions",
      endpoint_path: "/v1/chat/completions",
      primary_origin: PRIMARY_ORIGIN,
      backup_origin: BACKUP_ORIGIN,
      output_token_field: "max_completion_tokens",
      thinking_control: "provider_default",
      supports_responses: true,
      responses_path: "/v1/responses",
      documentation_url: "https://lconai.apifox.cn/",
    };
    const notes = "渠道：LConAI 主节点（n.lconai.com），分组 G2。普通智能体对话按官方 OpenAI Chat Completions（/v1/chat/completions）调用；GPT-6.1 使用 max_completion_tokens，不发送文档未定义的 enable_thinking。备用节点为 s.lconai.com；Responses（/v1/responses）保留给后续 Codex/工具链专用适配。价格口径：基础单价 4/15/5 × 渠道倍率 2.5 = 真实成本 10/37.5/12.5 元/百万 Token；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。";

    await database.query(
      `UPDATE public.llm_models
          SET api_endpoint=$2,
              proxy_url=$2,
              deep_thinking_type=0,
              deduct_deep_think=1,
              api_protocol_config=$3::jsonb,
              admin_notes=$4,
              updated_at=now()
        WHERE id=$1`,
      [MODEL_ID, PRIMARY_ORIGIN, JSON.stringify(nextProtocolConfig), notes],
    );

    const readback = await database.query(selection, [MODEL_ID]);
    assert.equal(readback.rowCount, 1, "GPT61_READBACK_MISSING");
    after = readback.rows[0];
    assert.equal(normalizeOrigin(after.api_endpoint), PRIMARY_ORIGIN, "GPT61_PRIMARY_ENDPOINT_READBACK_FAILED");
    assert.equal(normalizeOrigin(after.proxy_url), PRIMARY_ORIGIN, "GPT61_PRIMARY_PROXY_READBACK_FAILED");
    assert.equal(Number(after.deep_thinking_type), 0, "GPT61_THINKING_MODE_READBACK_FAILED");
    assert.equal(Number(after.deduct_deep_think), 1, "GPT61_THINKING_DEDUCTION_READBACK_FAILED");
    assert.deepEqual(protectedBinding(after), protectedBinding(before), "GPT61_PROTECTED_CONFIGURATION_CHANGED");
    assert.equal(after.api_protocol_config?.protocol, "openai_chat_completions", "GPT61_PROTOCOL_READBACK_FAILED");
    assert.equal(after.api_protocol_config?.output_token_field, "max_completion_tokens", "GPT61_OUTPUT_TOKEN_FIELD_READBACK_FAILED");
    assert.equal(after.api_protocol_config?.thinking_control, "provider_default", "GPT61_THINKING_CONTROL_READBACK_FAILED");

    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await database.end().catch(() => undefined);
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    scope: "local-runtime-configuration-only",
    modelId: MODEL_ID,
    before: safeBinding(before),
    after: safeBinding(after),
    validationEvidenceCurrent: false,
    requiresRealCanary: true,
    providerRequests: 0,
    paidGenerationRequests: 0,
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
