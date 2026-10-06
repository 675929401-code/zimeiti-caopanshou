#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const COST_MARKUP_PERCENT = 20;
const PROFIT_MARGIN_PERCENT = (COST_MARKUP_PERCENT / (100 + COST_MARKUP_PERCENT)) * 100;
const EVIDENCE_DIR = path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005");

const TARGETS = new Map([
  ["gpt-6.1-sol", {
    id: "76b48548-6542-4908-a9f7-10835d2528bb",
    displayName: "GPT-6.1 Sol · LConAI G2",
    baseCosts: [4, 15, 5],
    multiplier: 2.5,
    costs: [10, 37.5, 12.5],
    protocol: "openai_chat_completions",
    endpointPath: "/v1/chat/completions",
    adminNotes: "渠道：LConAI 主节点（n.lconai.com），分组 G2。普通智能体对话按官方 OpenAI Chat Completions（/v1/chat/completions）调用；GPT-6.1 使用 max_completion_tokens，不发送文档未定义的 enable_thinking。备用节点为 s.lconai.com；Responses（/v1/responses）保留给后续 Codex/工具链专用适配。价格口径：基础单价 4/15/5 × 渠道倍率 2.5 = 真实成本 10/37.5/12.5 元/百万 Token；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。",
  }],
  ["claude-opus-5-5", {
    id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
    displayName: "Claude Opus 5.5 · LConAI Claude Max",
    baseCosts: [4, 20, 8],
    multiplier: 1.8,
    costs: [7.2, 36, 14.4],
    protocol: "anthropic_messages",
    endpointPath: "/v1/messages",
    adminNotes: "渠道：LConAI 主节点（n.lconai.com），分组 Claude Max。按官方 Claude 原生 Anthropic Messages（/v1/messages）调用；system 使用顶层字段，输出上限使用 max_tokens，Authorization 使用 Bearer；备用节点为 s.lconai.com。价格口径：基础单价 4/20/8 × 渠道倍率 1.8 = 真实成本 7.2/36/14.4 元/百万 Token；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。",
  }],
  ["claude-sonnet-5-5", {
    id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
    displayName: "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
    baseCosts: [8, 0, 0],
    multiplier: 4,
    costs: [32, 0, 0],
    protocol: "anthropic_messages",
    endpointPath: "/v1/messages",
    adminNotes: "渠道：LConAI 主节点（n.lconai.com），分组 Claude AWS/G2。按官方 Claude 原生 Anthropic Messages（/v1/messages）调用；system 使用顶层字段，输出上限使用 max_tokens，Authorization 使用 Bearer；备用节点为 s.lconai.com。价格口径：基础单价 8/0/0 × 渠道倍率 4 = 真实成本 32/0/0 元/百万 Token；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%；输出和缓存零值来自用户工作簿，不自行补猜。",
  }],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function nearlyEqual(left, right, tolerance = 1e-9) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function assertWorkbookCostMapping(target) {
  for (let index = 0; index < target.costs.length; index += 1) {
    assert.ok(
      nearlyEqual(target.baseCosts[index] * target.multiplier, target.costs[index]),
      `WORKBOOK_COST_MULTIPLIER_MISMATCH:${index}`,
    );
  }
}

function salePrices(costs) {
  return costs.map((cost) => Number((cost * (1 + COST_MARKUP_PERCENT / 100)).toFixed(12)));
}

function safeModel(model) {
  return {
    id: String(model?.id || ""),
    name: String(model?.name || ""),
    modelName: String(model?.model_name || ""),
    active: model?.is_active === true,
    hidden: model?.is_hidden === true,
    userAccess: String(model?.user_access || ""),
    inputCostPerMillion: Number(model?.input_cost_per_million),
    outputCostPerMillion: Number(model?.output_cost_per_million),
    cachedCostPerMillion: Number(model?.cached_cost_per_million),
    profitMarginPercent: Number(model?.profit_margin),
    protocol: String(model?.api_protocol_config?.protocol || ""),
    endpointPath: String(model?.api_protocol_config?.endpoint_path || ""),
    adminNotes: String(model?.admin_notes || ""),
  };
}

async function requestJson(origin, headers, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}:${String(body?.code || body?.error || "UNKNOWN")}`);
  return body;
}

async function post(origin, headers, pathname, body) {
  return requestJson(origin, headers, pathname, { method: "POST", body: JSON.stringify(body) });
}

async function publishRelease(origin, headers, releaseId) {
  const validated = await post(origin, headers, "/api/admin/model-pool-releases", {
    action: "validate",
    releaseId,
  });
  assert.equal(validated.release?.status, "validated", "MODEL_POOL_VALIDATION_FAILED");
  const preview = await requestJson(
    origin,
    headers,
    `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`,
  );
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "MODEL_POOL_PREVIEW_HASH_MISSING");
  const published = await post(origin, headers, "/api/admin/model-pool-releases", {
    action: "publish",
    releaseId,
    previewSha256,
  });
  assert.equal(published.release?.status, "published", "MODEL_POOL_PUBLISH_FAILED");
  assert.equal(published.release?.is_current, true, "MODEL_POOL_NOT_CURRENT");
  return {
    id: releaseId,
    version: Number(published.release?.release_version || 0),
    previewSha256,
  };
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-cost-markup-20"), "COST_MARKUP_CONFIRMATION_REQUIRED");
  const targetName = argumentValue(args, "model");
  const target = TARGETS.get(targetName);
  assert.ok(target, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");
  assertWorkbookCostMapping(target);

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
    application_name: `codex-lconai-${targetName}-pricing-markup20`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = await requestJson(origin, basicHeaders, "/api/admin/access-control/self");
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  let cleanupVerified = false;
  let before;
  let after;
  let release = null;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Pricing-Markup20/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    const inventoryBefore = await requestJson(origin, headers, "/api/admin/models");
    const beforeModel = (inventoryBefore.models || []).find((model) => String(model.id) === target.id);
    assert.ok(beforeModel, "TARGET_MODEL_NOT_FOUND");
    before = safeModel(beforeModel);
    assert.equal(before.name, target.displayName, "TARGET_DISPLAY_NAME_MISMATCH");
    assert.equal(before.modelName, targetName, "TARGET_PROVIDER_MODEL_MISMATCH");
    assert.equal(before.protocol, target.protocol, "TARGET_PROTOCOL_MISMATCH");
    assert.equal(before.endpointPath, target.endpointPath, "TARGET_ENDPOINT_PATH_MISMATCH");
    const beforeCosts = [before.inputCostPerMillion, before.outputCostPerMillion, before.cachedCostPerMillion];
    beforeCosts.forEach((cost, index) => assert.ok(nearlyEqual(cost, target.costs[index]), `TARGET_COST_MISMATCH:${index}`));
    assert.ok(
      nearlyEqual(before.profitMarginPercent, 20) || nearlyEqual(before.profitMarginPercent, PROFIT_MARGIN_PERCENT),
      `UNEXPECTED_EXISTING_PROFIT_MARGIN:${before.profitMarginPercent}`,
    );

    const alreadyConfigured = nearlyEqual(before.profitMarginPercent, PROFIT_MARGIN_PERCENT)
      && before.adminNotes === target.adminNotes;
    if (!alreadyConfigured) {
      const staged = await requestJson(origin, headers, "/api/admin/models", {
        method: "PUT",
        body: JSON.stringify({
          model_type: "text",
          id: target.id,
          profit_margin: PROFIT_MARGIN_PERCENT,
          admin_notes: target.adminNotes,
        }),
      });
      assert.equal(staged.staged, true, "PRICING_UPDATE_NOT_STAGED");
      assert.equal(staged.published, false, "PRICING_UPDATE_UNEXPECTED_AUTO_PUBLISH");
      const releaseId = String(staged.result?.release?.id || "");
      assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "MODEL_POOL_RELEASE_ID_MISSING");
      release = await publishRelease(origin, headers, releaseId);
    }

    const inventoryAfter = await requestJson(origin, headers, "/api/admin/models");
    const afterModel = (inventoryAfter.models || []).find((model) => String(model.id) === target.id);
    assert.ok(afterModel, "TARGET_MODEL_READBACK_MISSING");
    after = safeModel(afterModel);
    const afterCosts = [after.inputCostPerMillion, after.outputCostPerMillion, after.cachedCostPerMillion];
    afterCosts.forEach((cost, index) => assert.ok(nearlyEqual(cost, target.costs[index]), `TARGET_COST_READBACK_MISMATCH:${index}`));
    assert.ok(nearlyEqual(after.profitMarginPercent, PROFIT_MARGIN_PERCENT), "TARGET_PROFIT_MARGIN_READBACK_MISMATCH");
    assert.equal(after.adminNotes, target.adminNotes, "TARGET_PRICING_NOTE_READBACK_MISMATCH");
    assert.equal(after.protocol, target.protocol, "TARGET_PROTOCOL_CHANGED");
    assert.equal(after.endpointPath, target.endpointPath, "TARGET_ENDPOINT_PATH_CHANGED");

    const sales = afterCosts.map((cost) => cost / (1 - after.profitMarginPercent / 100));
    const expectedSales = salePrices(target.costs);
    sales.forEach((sale, index) => assert.ok(nearlyEqual(sale, expectedSales[index], 1e-8), `TARGET_SALE_PRICE_MISMATCH:${index}`));

    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      scope: "local-runtime-configuration-only",
      modelId: target.id,
      modelName: targetName,
      workbookPricing: {
        baseCostsPerMillion: target.baseCosts,
        channelMultiplier: target.multiplier,
        actualCostsPerMillion: target.costs,
        costMarkupPercent: COST_MARKUP_PERCENT,
        backendProfitMarginPercent: PROFIT_MARGIN_PERCENT,
        sellingPricesPerMillion: expectedSales,
      },
      before,
      after,
      modelPoolRelease: release,
      requiresFreshPaidCanary: before.profitMarginPercent !== after.profitMarginPercent,
      providerRequests: 0,
      paidProviderCalls: 0,
      productionWrites: 0,
    };
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
    const evidencePath = path.join(EVIDENCE_DIR, `${targetName}-pricing-cost-markup20-config-update.json`);
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, evidencePath: path.relative(process.cwd(), evidencePath).replaceAll("\\", "/") }, null, 2));
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
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  await main();
}
