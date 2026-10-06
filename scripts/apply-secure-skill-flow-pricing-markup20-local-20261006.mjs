#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-flow-pricing-markup20.json",
);
const RETIRED_REASON = "RETIRED_GLOBAL_VIDEO_MARKUP: 视频售价必须逐模型读取运营价格表，禁止按成本百分比批量推导";

const TARGETS = [
  { id: "secure-skill-flow-omni-ch14", cost: 0.63, sale: 0.756 },
  { id: "secure-skill-flow-veo-3-1-i2v-lite-ch14", cost: 0.5, sale: 0.6 },
  { id: "secure-skill-flow-veo-3-1-i2v-fast-ch14", cost: 0.6, sale: 0.72 },
  { id: "secure-skill-flow-veo-3-1-interpolation-lite-ch14", cost: 0.5, sale: 0.6 },
  { id: "secure-skill-flow-veo-3-1-r2v-fast-ch14", cost: 0.6, sale: 0.72 },
  { id: "secure-skill-flow-veo-3-1-t2v-fast-ch14", cost: 0.6, sale: 0.72 },
  { id: "secure-skill-flow-veo-3-1-t2v-lite-ch14", cost: 0.5, sale: 0.6 },
];

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

async function publishRelease(origin, headers, releaseId) {
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

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${label}:${actual}!=${expected}`);
}

export async function main(args = process.argv.slice(2)) {
  throw new Error(RETIRED_REASON);
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-cost-plus-20"), "COST_PLUS_20_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };
  const releases = [];
  const results = [];

  for (const target of TARGETS) {
    const beforeInventory = await requestJson(origin, headers, "/api/admin/models");
    const before = (beforeInventory.models || []).find((model) => model.id === target.id);
    assert.ok(before, `${target.id}:MODEL_NOT_FOUND`);
    closeTo(before.cost_price, target.cost, `${target.id}:COST_SOURCE_MISMATCH`);
    assert.equal(before.is_active, true, `${target.id}:EXPECTED_ACTIVE`);
    assert.equal(before.is_hidden, false, `${target.id}:EXPECTED_VISIBLE`);
    assert.equal(before.api_protocol_config?.billing_unit, "per_use", `${target.id}:BILLING_UNIT_MISMATCH`);
    assert.equal(before.api_protocol_config?.__model_activation_gate?.state, "evidence_ready", `${target.id}:ACCEPTANCE_GATE_MISMATCH`);

    const staged = await requestJson(origin, headers, "/api/admin/models", {
      method: "PUT",
      body: JSON.stringify({
        model_type: "video",
        id: target.id,
        cost_price: target.cost,
        cost_per_use: target.sale,
      }),
    });
    assert.equal(staged.staged, true, `${target.id}:NOT_STAGED`);
    assert.equal(staged.published, false, `${target.id}:UNEXPECTED_AUTO_PUBLISH`);
    const releaseId = String(staged.result?.release?.id || "");
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${target.id}:RELEASE_ID_MISSING`);
    releases.push({ modelId: target.id, ...(await publishRelease(origin, headers, releaseId)) });

    const afterInventory = await requestJson(origin, headers, "/api/admin/models");
    const after = (afterInventory.models || []).find((model) => model.id === target.id);
    assert.ok(after, `${target.id}:READBACK_MISSING`);
    closeTo(after.cost_price, target.cost, `${target.id}:COST_READBACK`);
    closeTo(after.cost_per_use ?? after.price_per_use, target.sale, `${target.id}:SALE_READBACK`);
    assert.equal(after.is_active, true, `${target.id}:ACTIVE_STATE_CHANGED`);
    assert.equal(after.is_hidden, false, `${target.id}:HIDDEN_STATE_CHANGED`);
    assert.equal(after.api_protocol_config?.__model_activation_gate?.state, "evidence_ready", `${target.id}:ACCEPTANCE_GATE_CHANGED`);
    results.push({
      id: target.id,
      cost: target.cost,
      saleBefore: Number(before.cost_per_use ?? before.price_per_use),
      saleAfter: target.sale,
      markupPercent: 20,
      active: true,
      hidden: false,
      activationGate: "evidence_ready",
    });
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    models: results,
    releases,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
