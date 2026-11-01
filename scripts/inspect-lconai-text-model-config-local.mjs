#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pg from "pg";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
// The stored endpoint is the provider's OpenAI/Anthropic API root.  `/v1`
// is part of the configured binding and must not be stripped by this audit.
const PRIMARY_ORIGIN = "https://n.lconai.com/v1";
const COST_MARKUP_PERCENT = 20;
const EXPECTED_PROFIT_MARGIN_PERCENT = (COST_MARKUP_PERCENT / (100 + COST_MARKUP_PERCENT)) * 100;
const TARGETS = [
  { id: "76b48548-6542-4908-a9f7-10835d2528bb", modelName: "gpt-6.1-sol", secretRef: "secret://lconai-gpt-6-1-sol" },
  { id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81", modelName: "claude-opus-5-5", secretRef: "secret://lconai-claude-opus-5-5" },
  { id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af", modelName: "claude-sonnet-5-5", secretRef: "secret://lconai-claude-sonnet-5-5" },
];

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const database = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-inspect-lconai-text-model-config-local",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

function nearlyEqual(left, right, tolerance = 1e-8) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

try {
  await database.connect();
  const result = await database.query(
    `SELECT id::text,name,model_name,api_endpoint,proxy_url,api_key,
            is_active,is_hidden,user_access,sort_order,
            input_cost_per_million,output_cost_per_million,cached_cost_per_million,
            profit_margin,api_protocol_config
       FROM public.llm_models
      WHERE id = ANY($1::uuid[])
      ORDER BY sort_order,id`,
    [TARGETS.map((target) => target.id)],
  );
  assert.equal(result.rowCount, TARGETS.length, "TARGET_MODEL_COUNT_MISMATCH");
  const rows = result.rows.map((row) => {
    const target = TARGETS.find((candidate) => candidate.id === row.id);
    assert.ok(target, `UNEXPECTED_MODEL:${row.id}`);
    assert.equal(row.model_name, target.modelName, `MODEL_NAME_MISMATCH:${target.modelName}`);
    const costs = [
      Number(row.input_cost_per_million),
      Number(row.output_cost_per_million),
      Number(row.cached_cost_per_million),
    ];
    const profitMargin = Number(row.profit_margin);
    return {
      id: row.id,
      name: row.name,
      modelName: row.model_name,
      apiEndpoint: normalizeOrigin(row.api_endpoint),
      proxyUrl: normalizeOrigin(row.proxy_url),
      credentialReferenceMatches: row.api_key === target.secretRef,
      active: row.is_active === true,
      hidden: row.is_hidden === true,
      userAccess: row.user_access,
      sortOrder: Number(row.sort_order),
      pricing: {
        input: String(row.input_cost_per_million),
        output: String(row.output_cost_per_million),
        cached: String(row.cached_cost_per_million),
        profitMargin: String(row.profit_margin),
        sellingPrices: costs.map((cost) => cost / (1 - profitMargin / 100)),
      },
      protocol: {
        name: row.api_protocol_config?.protocol || null,
        endpointPath: row.api_protocol_config?.endpoint_path || null,
        outputTokenField: row.api_protocol_config?.output_token_field || null,
        thinkingControl: row.api_protocol_config?.thinking_control || null,
      },
    };
  });
  if (process.argv.includes("--expect-primary")) {
    for (const row of rows) {
      assert.equal(row.apiEndpoint, PRIMARY_ORIGIN, `PRIMARY_API_ENDPOINT_REQUIRED:${row.modelName}`);
      assert.equal(row.proxyUrl, PRIMARY_ORIGIN, `PRIMARY_PROXY_URL_REQUIRED:${row.modelName}`);
      assert.equal(row.credentialReferenceMatches, true, `CREDENTIAL_REFERENCE_MISMATCH:${row.modelName}`);
      assert.equal(row.active, true, `ACTIVE_MODEL_REQUIRED:${row.modelName}`);
      assert.equal(row.hidden, false, `VISIBLE_MODEL_REQUIRED:${row.modelName}`);
      assert.equal(row.userAccess, "available", `USER_ACCESS_REQUIRED:${row.modelName}`);
    }
  }
  if (process.argv.includes("--expect-cost-markup-20")) {
    for (const row of rows) {
      const costs = [Number(row.pricing.input), Number(row.pricing.output), Number(row.pricing.cached)];
      assert.ok(
        nearlyEqual(Number(row.pricing.profitMargin), EXPECTED_PROFIT_MARGIN_PERCENT),
        `PROFIT_MARGIN_MAPPING_MISMATCH:${row.modelName}`,
      );
      row.pricing.sellingPrices.forEach((sellingPrice, index) => {
        assert.ok(
          nearlyEqual(sellingPrice, costs[index] * (1 + COST_MARKUP_PERCENT / 100)),
          `COST_MARKUP_MISMATCH:${row.modelName}:${index}`,
        );
      });
    }
  }
  console.log(JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), rows }, null, 2));
} finally {
  await database.end().catch(() => undefined);
}
