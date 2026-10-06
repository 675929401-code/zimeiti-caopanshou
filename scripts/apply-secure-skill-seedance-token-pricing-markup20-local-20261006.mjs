#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-seedance-token-pricing-markup20.json",
);
const RETIRED_REASON = "RETIRED_GLOBAL_VIDEO_MARKUP: 视频售价必须逐模型读取运营价格表，禁止按成本百分比批量推导";
const DECIMAL_CORRECTION_EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-seedance-token-pricing-markup20-exact-decimals.json",
);

const saleWithMarkup20 = (cost) => Number((Number(cost) * 1.2).toFixed(6));

const TARGETS = [
  {
    id: "secure-skill-doubao-seedance-2-0-g37",
    modelName: "doubao-seedance-2-0-260128",
    displayName: "Seedance 2.0 · 官方 Token · 720P · 4–15秒",
    noReferenceCost: 31.74,
    referenceVideoCost: 19.32,
  },
  {
    id: "secure-skill-doubao-seedance-2-0-fast-g37",
    modelName: "doubao-seedance-2-0-fast-260128",
    displayName: "Seedance 2.0 Fast · 官方 Token · 720P · 4–15秒",
    noReferenceCost: 25.53,
    referenceVideoCost: 15.18,
  },
  {
    id: "secure-skill-doubao-seedance-2-5-g37",
    modelName: "doubao-seedance-2-5-260628",
    displayName: "Seedance 2.5 · 官方 Token · 720P · 4–30秒",
    noReferenceCost: 49.7,
    referenceVideoCost: 29.82,
  },
].map((target) => ({
  ...target,
  noReferenceSale: saleWithMarkup20(target.noReferenceCost),
  referenceVideoSale: saleWithMarkup20(target.referenceVideoCost),
}));

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
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}:${String(body?.code || body?.error || "UNKNOWN").slice(0, 200)}`);
  return body;
}

async function validatePreviewPublish(origin, headers, releaseId) {
  const validated = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  });
  assert.equal(validated.release?.status, "validated", `${releaseId}:VALIDATION_FAILED`);
  const preview = await requestJson(
    origin,
    headers,
    `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`,
  );
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, `${releaseId}:PREVIEW_HASH_MISSING`);
  const published = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
  assert.equal(published.release?.status, "published", `${releaseId}:PUBLISH_FAILED`);
  assert.equal(published.release?.is_current, true, `${releaseId}:NOT_CURRENT`);
  return { id: releaseId, version: Number(published.release?.release_version || 0) };
}

function withoutActivationGate(value) {
  const source = structuredClone(value || {});
  delete source.__model_activation_gate;
  return source;
}

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(Number(actual) - expected) < 0.000_001, `${label}:${actual}!=${expected}`);
}

export async function main(args = process.argv.slice(2)) {
  throw new Error(RETIRED_REASON);
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-token-pricing-markup20"), "EXPLICIT_LOCAL_PRICING_CONFIRMATION_REQUIRED");
  const decimalCorrection = args.includes("--exact-decimal-correction");
  const selectedTargets = decimalCorrection
    ? TARGETS.filter((target) => target.id !== "secure-skill-doubao-seedance-2-5-g37")
    : TARGETS;
  const evidencePath = decimalCorrection ? DECIMAL_CORRECTION_EVIDENCE_PATH : EVIDENCE_PATH;
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };
  const releases = [];
  const beforeSummary = [];

  for (const target of selectedTargets) {
    const inventory = await requestJson(origin, headers, "/api/admin/models");
    const before = (inventory.models || []).find((model) => model.id === target.id);
    assert.ok(before, `${target.id}:MODEL_NOT_FOUND`);
    assert.equal(before.model_name, target.modelName, `${target.id}:MODEL_NAME_MISMATCH`);
    assert.equal(before.api_protocol_config?.provider_billing_unit, "token", `${target.id}:PROVIDER_TOKEN_BILLING_REQUIRED`);
    beforeSummary.push({
      id: target.id,
      cost: Number(before.cost_price),
      sale: Number(before.cost_per_use ?? before.price_per_use),
      active: before.is_active === true,
      hidden: before.is_hidden === true,
    });

    const nextProtocol = {
      ...withoutActivationGate(before.api_protocol_config),
      provider_billing_unit: "token",
      billing_unit: "per_use",
      public_billing_pending: true,
      public_billing_pending_reason: "等待本站按 usage.total_tokens 精确结算后再启用生成",
      token_billing_adapter_ready: false,
      pricing_markup_percent: 20,
      pricing_formula: "supplier_unit_cost_x_1.20",
      token_cost_prices_per_million: {
        "720p:no_reference_video": target.noReferenceCost,
        "720p:reference_video": target.referenceVideoCost,
      },
      token_sale_prices_per_million: {
        "720p:no_reference_video": target.noReferenceSale,
        "720p:reference_video": target.referenceVideoSale,
      },
      resolution_cost_prices: { "720p": target.noReferenceCost },
      resolution_prices: { "720p": target.noReferenceSale },
      resolution_options: ["720p"],
      default_resolution: "720p",
    };
    const notes = [
      "渠道：Secure Skill 中转 · Seedance 官方 Token 版 · 分组37；不是固定按次计费。",
      `供应商成本：无参考视频 ¥${target.noReferenceCost}/百万Token，含参考视频 ¥${target.referenceVideoCost}/百万Token。`,
      `本站售价严格为成本×1.20：无参考视频 ¥${target.noReferenceSale}/百万Token，含参考视频 ¥${target.referenceVideoSale}/百万Token。`,
      "平台必须读取 usage.total_tokens 精确结算；适配完成前模型保留展示但禁止提交，不能把百万 Token 单价当成单次价格。",
    ].join("\n");
    const staged = await requestJson(origin, headers, "/api/admin/models", {
      method: "PUT",
      body: JSON.stringify({
        model_type: "video",
        id: target.id,
        name: target.displayName,
        cost_price: target.noReferenceCost,
        cost_per_use: target.noReferenceSale,
        admin_notes: notes,
        api_protocol_config: nextProtocol,
      }),
    });
    assert.equal(staged.staged, true, `${target.id}:NOT_STAGED`);
    assert.equal(staged.published, false, `${target.id}:UNEXPECTED_AUTO_PUBLISH`);
    const releaseId = String(staged.result?.release?.id || "");
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${target.id}:RELEASE_ID_MISSING`);
    releases.push({ modelId: target.id, ...(await validatePreviewPublish(origin, headers, releaseId)) });

    const afterInventory = await requestJson(origin, headers, "/api/admin/models");
    const after = (afterInventory.models || []).find((model) => model.id === target.id);
    assert.equal(after?.name, target.displayName, `${target.id}:DISPLAY_NAME_READBACK`);
    closeTo(after?.cost_price, target.noReferenceCost, `${target.id}:COST_READBACK`);
    closeTo(after?.cost_per_use ?? after?.price_per_use, target.noReferenceSale, `${target.id}:SALE_READBACK`);
    assert.equal(after?.is_active, true, `${target.id}:ACTIVE_FLAG_CHANGED`);
    assert.equal(after?.is_hidden, false, `${target.id}:VISIBILITY_FLAG_CHANGED`);
    assert.equal(after?.api_protocol_config?.provider_billing_unit, "token", `${target.id}:PROVIDER_BILLING_READBACK`);
    assert.equal(after?.api_protocol_config?.public_billing_pending, true, `${target.id}:PENDING_GATE_READBACK`);
    assert.equal(after?.api_protocol_config?.token_billing_adapter_ready, false, `${target.id}:ADAPTER_GATE_READBACK`);
    closeTo(after?.api_protocol_config?.token_sale_prices_per_million?.["720p:no_reference_video"], target.noReferenceSale, `${target.id}:TOKEN_SALE_NO_REFERENCE`);
    closeTo(after?.api_protocol_config?.token_sale_prices_per_million?.["720p:reference_video"], target.referenceVideoSale, `${target.id}:TOKEN_SALE_REFERENCE`);
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    pricingRule: "supplier_unit_cost_x_1.20",
    providerBillingUnit: "token",
    publicGenerationGate: "blocked_until_exact_usage_total_tokens_settlement",
    before: beforeSummary,
    after: selectedTargets.map((target) => ({
      id: target.id,
      costPerMillionTokens: {
        noReferenceVideo: target.noReferenceCost,
        referenceVideo: target.referenceVideoCost,
      },
      salePerMillionTokens: {
        noReferenceVideo: target.noReferenceSale,
        referenceVideo: target.referenceVideoSale,
      },
      markupPercent: 20,
      active: true,
      hidden: false,
    })),
    releases,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
    localConfigurationWrites: selectedTargets.length,
  };
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
