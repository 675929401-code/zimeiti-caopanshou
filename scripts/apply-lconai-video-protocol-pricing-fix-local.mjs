#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRIMARY_ORIGIN = "https://n.lconai.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/lconai-video-billing-unit-correction.json",
);

const TARGETS = [
  {
    id: "seedance-2-5-480p-i2v-lconai",
    modelName: "seedance-2-5-480p-i2v",
    cost: 1.224,
    sale: 1.2,
    billingUnit: "output_second",
    protocol: {
      billing_unit: "output_second",
      request_format: "json",
      submit_path: "/v1/videos",
      poll_path: "/v1/videos/{id}",
      duration_field: "duration",
      aspect_ratio_field: "ratio",
      image_field: "images",
      image_field_type: "array",
      resolution_field: "resolution",
      default_resolution: "480p",
      resolution_prices: { "480p": 1.2 },
      resolution_cost_prices: { "480p": 1.224 },
      task_id_path: "id",
      status_path: "status",
      video_url_path: "video_url",
    },
    notes: "LConAI 主节点 n.lconai.com；Seedance JSON /v1/videos 异步协议；工作簿明确成本 ¥1.224/输出秒、售价 ¥1.2/输出秒。",
  },
  {
    id: "seedance-2-0-fast-720p-i2v-lconai",
    modelName: "seedance-2-0-fast-720p-i2v",
    cost: 0.504,
    sale: 0.5,
    billingUnit: "output_second",
    protocol: {
      billing_unit: "output_second",
      request_format: "json",
      submit_path: "/v1/videos",
      poll_path: "/v1/videos/{id}",
      duration_field: "duration",
      aspect_ratio_field: "ratio",
      image_field: "images",
      image_field_type: "array",
      resolution_field: "resolution",
      default_resolution: "720p",
      resolution_prices: { "720p": 0.5 },
      resolution_cost_prices: { "720p": 0.504 },
      task_id_path: "id",
      status_path: "status",
      video_url_path: "video_url",
    },
    notes: "LConAI 主节点 n.lconai.com；Seedance JSON /v1/videos 异步协议；工作簿明确成本 ¥0.504/输出秒、售价 ¥0.5/输出秒。",
  },
  {
    id: "grok-video-3-pro-lconai",
    modelName: "grok-video-3-pro",
    cost: 0.81,
    sale: 0.8,
    billingUnit: "per_use",
    protocol: {
      billing_unit: "per_use",
      request_format: "multipart",
      submit_path: "/v1/videos",
      poll_path: "/v1/videos/{id}",
      duration_field: "seconds",
      size_field: "size",
      size_value_source: "aspect_ratio",
      image_field: "input_reference",
      task_id_path: "id",
      status_path: "status",
      video_url_path: "video_url",
      duration_options: [10],
      default_resolution: "720p",
      resolution_prices: { "720p": 0.8 },
      resolution_cost_prices: { "720p": 0.81 },
    },
    notes: "LConAI 主节点 n.lconai.com；Grok multipart/form-data /v1/videos 异步协议；工作簿明确成本 ¥0.81/次、售价 ¥0.8/次（10秒）。",
  },
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

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-lconai-video-protocol-and-pricing"), "EXPLICIT_PROTOCOL_PRICING_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };
  const releases = [];

  for (const target of TARGETS) {
    const inventory = await requestJson(origin, headers, "/api/admin/models");
    const before = (inventory.models || []).find((model) => model.id === target.id);
    assert.ok(before, `${target.modelName}:MODEL_NOT_FOUND`);
    assert.equal(before.model_name, target.modelName, `${target.modelName}:MODEL_NAME_MISMATCH`);
    const nextProtocol = {
      ...withoutActivationGate(before.api_protocol_config),
      ...target.protocol,
    };
    delete nextProtocol.omit_aspect_ratio;
    const staged = await requestJson(origin, headers, "/api/admin/models", {
      method: "PUT",
      body: JSON.stringify({
        model_type: "video",
        id: target.id,
        api_endpoint: PRIMARY_ORIGIN,
        provider: "newapi_video",
        protocol_type: "newapi_video",
        cost_price: target.cost,
        cost_per_use: target.sale,
        admin_notes: target.notes,
        api_protocol_config: nextProtocol,
      }),
    });
    assert.equal(staged.staged, true, `${target.modelName}:NOT_STAGED`);
    assert.equal(staged.published, false, `${target.modelName}:UNEXPECTED_AUTO_PUBLISH`);
    const releaseId = String(staged.result?.release?.id || "");
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${target.modelName}:RELEASE_ID_MISSING`);
    releases.push({ modelName: target.modelName, ...(await validatePreviewPublish(origin, headers, releaseId)) });

    const afterInventory = await requestJson(origin, headers, "/api/admin/models");
    const after = (afterInventory.models || []).find((model) => model.id === target.id);
    assert.equal(String(after?.api_endpoint || "").replace(/\/+$/u, ""), PRIMARY_ORIGIN, `${target.modelName}:ENDPOINT_READBACK`);
    assert.equal(after?.protocol_type, "newapi_video", `${target.modelName}:PROTOCOL_READBACK`);
    assert.equal(Number(after?.cost_price), target.cost, `${target.modelName}:COST_READBACK`);
    assert.equal(Number(after?.cost_per_use ?? after?.price_per_use), target.sale, `${target.modelName}:SALE_READBACK`);
    assert.equal(after?.api_protocol_config?.billing_unit, target.billingUnit, `${target.modelName}:BILLING_UNIT_READBACK`);
    assert.equal(after?.api_protocol_config?.request_format, target.protocol.request_format, `${target.modelName}:FORMAT_READBACK`);
    assert.ok(after?.api_protocol_config?.__model_activation_gate, `${target.modelName}:ACTIVATION_GATE_REQUIRED`);
  }

  const publicModels = await requestJson(origin, { Authorization: `Bearer ${token}` }, "/api/video/models?surface=storyboard-workbench");
  for (const target of TARGETS) {
    assert.equal((publicModels.models || []).some((model) => model.id === target.id), false, `${target.modelName}:PENDING_MODEL_PUBLIC_LEAK`);
  }
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    providerEndpoint: PRIMARY_ORIGIN,
    models: TARGETS.map((target) => ({
      id: target.id,
      modelName: target.modelName,
      cost: target.cost,
      sale: target.sale,
      pricingSource: "user_workbook_explicit_sale",
      billingUnit: target.billingUnit,
      requestFormat: target.protocol.request_format,
      activationGate: "revalidation_required",
    })),
    releases,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
