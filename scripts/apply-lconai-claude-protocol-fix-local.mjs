#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const PRIMARY_ORIGIN = "https://n.lconai.com";
const BACKUP_ORIGIN = "https://s.lconai.com";
const TARGETS = new Map([
  ["claude-opus-5-5", {
    id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
    name: "Claude Opus 5.5 · LConAI Claude Max",
    secretRef: "secret://lconai-claude-opus-5-5",
    connectionGroup: "Claude Max",
    thinkingControl: "structured_disabled_when_requested",
    pricingNote: "基础单价 4/20/8 × 渠道倍率 1.8 保存为真实成本 7.2/36/14.4；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。",
  }],
  ["claude-sonnet-5-5", {
    id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
    name: "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
    secretRef: "secret://lconai-claude-sonnet-5-5",
    connectionGroup: "Claude AWS/G2",
    thinkingControl: "omit_optional_field",
    pricingNote: "基础单价 8/0/0 × 渠道倍率 4 保存为真实成本 32/0/0；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%；零值来自原表，不自行补猜。",
  }],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function protectedConfiguration(row) {
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
    maxContextRounds: row.max_context_rounds,
    maxContextTokens: row.max_context_tokens,
    maxReplyTokens: row.max_reply_tokens,
    timeout: row.timeout,
    deepThinkingType: row.deep_thinking_type,
    deductDeepThink: row.deduct_deep_think,
  };
}

function safeRow(row, target) {
  return {
    id: row.id,
    name: row.name,
    modelName: row.model_name,
    apiEndpoint: normalizeOrigin(row.api_endpoint),
    proxyUrl: normalizeOrigin(row.proxy_url),
    secretReferenceMatches: row.api_key === target.secretRef,
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    userAccess: row.user_access,
    deepThinkingType: Number(row.deep_thinking_type),
    maxContextTokens: Number(row.max_context_tokens),
    maxReplyTokens: Number(row.max_reply_tokens),
    protocolConfig: row.api_protocol_config || {},
    adminNotes: row.admin_notes || "",
  };
}

const selection = `
  SELECT id::text,name,model_name,api_endpoint,proxy_url,api_key,
         billing_mode,token_billing_enabled,input_cost_per_million,
         output_cost_per_million,cached_cost_per_million,profit_margin,
         max_context_rounds,max_context_tokens,max_reply_tokens,timeout,
         deep_thinking_type,deduct_deep_think,is_active,is_hidden,user_access,
         api_protocol_config,admin_notes
    FROM public.llm_models
   WHERE id=$1
`;

async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-lconai-claude-protocol"), "LOCAL_LCONAI_CLAUDE_PROTOCOL_CONFIRMATION_REQUIRED");
  const targetName = argumentValue(args, "model");
  const target = TARGETS.get(targetName);
  assert.ok(target, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");

  const catalogEvidencePath = path.resolve(
    `.codex-evidence/lconai-workbook-onboarding-20261005/${targetName}-catalog-readonly.json`,
  );
  const catalogEvidence = JSON.parse(await fs.readFile(catalogEvidencePath, "utf8"));
  assert.equal(catalogEvidence.passed, true, "CURRENT_CATALOG_EVIDENCE_REQUIRED");
  assert.equal(catalogEvidence.channelOrigin, PRIMARY_ORIGIN, "PRIMARY_CATALOG_ORIGIN_REQUIRED");
  assert.equal(catalogEvidence.catalog?.targetExact, true, "EXACT_PROVIDER_MODEL_REQUIRED");
  assert.ok(
    Array.isArray(catalogEvidence.catalog?.targetMetadata?.supported_endpoint_types)
      && catalogEvidence.catalog.targetMetadata.supported_endpoint_types.some((value) => /anthropic/iu.test(value)),
    "ANTHROPIC_ENDPOINT_SUPPORT_REQUIRED",
  );

  const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: `codex-lconai-${targetName}-protocol-fix-local`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });

  let before;
  let after;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    const locked = await database.query(`${selection} FOR UPDATE`, [target.id]);
    assert.equal(locked.rowCount, 1, "TARGET_MODEL_NOT_FOUND");
    before = locked.rows[0];
    assert.equal(before.name, target.name, "TARGET_DISPLAY_NAME_MISMATCH");
    assert.equal(before.model_name, targetName, "TARGET_PROVIDER_MODEL_MISMATCH");
    assert.equal(before.api_key, target.secretRef, "TARGET_SECRET_REFERENCE_MISMATCH");
    assert.ok(
      [PRIMARY_ORIGIN, BACKUP_ORIGIN].includes(normalizeOrigin(before.api_endpoint)),
      "LCONAI_ENDPOINT_REQUIRED",
    );

    const nextProtocolConfig = {
      ...(before.api_protocol_config || {}),
      channel: "lconai",
      connection_group: target.connectionGroup,
      protocol: "anthropic_messages",
      endpoint_path: "/v1/messages",
      primary_origin: PRIMARY_ORIGIN,
      backup_origin: BACKUP_ORIGIN,
      auth_scheme: "bearer",
      anthropic_version: "2023-06-01",
      output_token_field: "max_tokens",
      system_field: "top_level_system",
      thinking_control: target.thinkingControl,
      supported_endpoint_types: catalogEvidence.catalog.targetMetadata.supported_endpoint_types,
      catalog_verified_at: catalogEvidence.checkedAt,
      documentation_url: "https://lconai.apifox.cn/",
    };
    const notes = `渠道：LConAI 主节点（n.lconai.com），分组 ${target.connectionGroup}。按官方 Claude 原生 Anthropic Messages（/v1/messages）调用；system 使用顶层字段，输出上限使用 max_tokens，Authorization 使用 Bearer；备用节点为 s.lconai.com。${target.pricingNote}`;

    await database.query(
      `UPDATE public.llm_models
          SET api_endpoint=$2,
              proxy_url=$2,
              api_protocol_config=$3::jsonb,
              admin_notes=$4,
              updated_at=now()
        WHERE id=$1`,
      [target.id, PRIMARY_ORIGIN, JSON.stringify(nextProtocolConfig), notes],
    );

    const readback = await database.query(selection, [target.id]);
    assert.equal(readback.rowCount, 1, "TARGET_READBACK_MISSING");
    after = readback.rows[0];
    assert.equal(normalizeOrigin(after.api_endpoint), PRIMARY_ORIGIN, "PRIMARY_ENDPOINT_READBACK_FAILED");
    assert.equal(normalizeOrigin(after.proxy_url), PRIMARY_ORIGIN, "PRIMARY_PROXY_READBACK_FAILED");
    assert.equal(after.api_protocol_config?.protocol, "anthropic_messages", "PROTOCOL_READBACK_FAILED");
    assert.equal(after.api_protocol_config?.endpoint_path, "/v1/messages", "ENDPOINT_PATH_READBACK_FAILED");
    assert.deepEqual(protectedConfiguration(after), protectedConfiguration(before), "PROTECTED_CONFIGURATION_CHANGED");
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
    modelId: target.id,
    before: safeRow(before, target),
    after: safeRow(after, target),
    catalogEvidence: path.relative(process.cwd(), catalogEvidencePath).replaceAll("\\", "/"),
    validationEvidenceCurrent: false,
    requiresRealCanary: true,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  const evidencePath = path.resolve(
    `.codex-evidence/lconai-workbook-onboarding-20261005/${targetName}-protocol-config-update.json`,
  );
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
