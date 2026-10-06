#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASELINE_RELEASE_VERSION = 44;
const WORKBOOK_PATH = "C:/Users/Administrator/Desktop/请添加视频模型还有文案模型，添加后要检查功能链路是否通畅，接口协议是否吻合 遇到接口问题查阅官网api文档.xlsx";
const EXPECTED_WORKBOOK_SHA256 = "d153e2953b51b22ac0ff88d0a383005c6327205766e608f83e8b0ba9d0620546";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/video-pricing-user-table-correction.json",
);

// These are the only video rows in the supplied workbook. The left number is
// supplier cost and the explicitly labelled right number is the selling price.
// A selling price may be lower than cost; no global markup is applied.
const WORKBOOK_TARGETS = [
  {
    id: "seedance-2-5-480p-i2v-lconai",
    cost: 1.224,
    sale: 1.2,
    resolution: "480p",
    cell: "Sheet1!K6",
    unit: "output_second",
  },
  {
    id: "seedance-2-0-fast-720p-i2v-lconai",
    cost: 0.504,
    sale: 0.5,
    resolution: "720p",
    cell: "Sheet1!K7",
    unit: "output_second",
  },
  {
    id: "grok-video-3-pro-lconai",
    cost: 0.81,
    sale: 0.8,
    resolution: "720p",
    cell: "Sheet1!K8",
    unit: "per_use",
  },
];

// These rows were touched after release 44 by the mistaken global video
// cost-plus-20 operation. Restore only their price-bearing fields from that
// immutable pre-operation release; preserve every later protocol, gate, name,
// order and visibility change.
const RESTORE_TARGET_IDS = [
  "secure-skill-doubao-seedance-2-0-g37",
  "secure-skill-doubao-seedance-2-0-fast-g37",
  "secure-skill-doubao-seedance-2-5-g37",
  "secure-skill-flow-omni-ch14",
  "secure-skill-flow-veo-3-1-i2v-lite-ch14",
  "secure-skill-flow-veo-3-1-i2v-fast-ch14",
  "secure-skill-flow-veo-3-1-interpolation-lite-ch14",
  "secure-skill-flow-veo-3-1-r2v-fast-ch14",
  "secure-skill-flow-veo-3-1-t2v-fast-ch14",
  "secure-skill-flow-veo-3-1-t2v-lite-ch14",
  "secure-skill-minimax-h3-ecommerce-ch36",
  "secure-skill-seedance-2-5-enterprise-g16",
  "secure-skill-video-2-0-fast-g16",
  "secure-skill-video-2-0-pro-g16",
  "secure-skill-wan3-video-ch40",
  "secure-skill-wan3-video-prime-ch40",
  "minimax-h3-768p-lc",
  "omni-flash-10s-720p-ch3",
  "minimax-h3-2k-lc",
  "grok-imagine-1.5-15s-ch3",
  "veo-3-1-fast-chC",
  "grok-imagine-video-1-5-fast-chA",
  "omni-flash-8s-gaorui",
  "veo-3-1-components-gaorui",
  "veo-3-1-fl-gaorui",
];

const TOKEN_GATED_IDS = new Set([
  "secure-skill-doubao-seedance-2-0-g37",
  "secure-skill-doubao-seedance-2-0-fast-g37",
  "secure-skill-doubao-seedance-2-5-g37",
]);

const PRICE_PROTOCOL_KEYS = [
  "resolution_cost_prices",
  "resolution_prices",
  "token_cost_prices_per_million",
  "token_sale_prices_per_million",
  "pricing_markup_percent",
  "pricing_formula",
  "pricing_source",
  "pricing_source_reference",
  "supplier_pricing_note",
  "price_source_url",
  "price_verified_at",
  "price_verification",
];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function closeTo(actual, expected, label) {
  assert.ok(Number.isFinite(Number(actual)), `${label}:NOT_FINITE`);
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-9, `${label}:${actual}!=${expected}`);
}

function sameJson(actual, expected, label) {
  assert.deepEqual(actual ?? null, expected ?? null, label);
}

function entryById(snapshot, id) {
  return (snapshot?.models || []).find((entry) => entry.kind === "video" && entry.id === id);
}

function protocolContainers(entry) {
  const capabilities = object(entry.capabilities);
  const configuration = object(entry.configuration);
  const capabilityProtocol = object(capabilities.protocol);
  const configurationProtocol = object(configuration.protocolConfig);
  capabilities.protocol = capabilityProtocol;
  configuration.protocolConfig = configurationProtocol;
  entry.capabilities = capabilities;
  entry.configuration = configuration;
  return [capabilityProtocol, configurationProtocol];
}

function mirrorKeys(target, source, keys) {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) target[key] = structuredClone(source[key]);
    else delete target[key];
  }
}

function safePriceSummary(entry) {
  const protocol = object(object(entry.configuration).protocolConfig);
  return {
    id: entry.id,
    cost: Number(object(entry.pricing).cost),
    sale: Number(object(entry.pricing).selling),
    resolutionCostPrices: object(protocol.resolution_cost_prices),
    resolutionSalePrices: object(protocol.resolution_prices),
    tokenCostPricesPerMillion: object(protocol.token_cost_prices_per_million),
    tokenSalePricesPerMillion: object(protocol.token_sale_prices_per_million),
    billingUnit: String(protocol.billing_unit || ""),
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
  assert.ok(
    response.ok,
    `${pathname}:HTTP_${response.status}:${String(body?.code || body?.error || "UNKNOWN").slice(0, 200)}`,
  );
  return body;
}

async function workbookSha256() {
  const bytes = await fs.readFile(WORKBOOK_PATH);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function restorePreMarkupPrice(currentEntry, baselineEntry) {
  currentEntry.pricing = structuredClone(baselineEntry.pricing);
  const baselineProtocols = protocolContainers(structuredClone(baselineEntry));
  const currentProtocols = protocolContainers(currentEntry);
  for (let index = 0; index < currentProtocols.length; index += 1) {
    mirrorKeys(currentProtocols[index], baselineProtocols[index], PRICE_PROTOCOL_KEYS);
  }
  if (TOKEN_GATED_IDS.has(currentEntry.id)) {
    const oldNotes = String(object(baselineEntry.configuration).adminNotes || "").trim();
    currentEntry.configuration.adminNotes = [
      oldNotes,
      "供应商按 Token 计费；本站销售单价须由运营价格表逐项确认，未确认前禁止提交，不得按成本百分比自动生成售价。",
    ].filter(Boolean).join("\n");
  }
}

function applyWorkbookPrice(entry, target) {
  entry.pricing = {
    ...object(entry.pricing),
    currency: "CNY",
    cost: target.cost,
    selling: target.sale,
  };
  for (const protocol of protocolContainers(entry)) {
    protocol.resolution_cost_prices = { [target.resolution]: target.cost };
    protocol.resolution_prices = { [target.resolution]: target.sale };
    delete protocol.pricing_markup_percent;
    delete protocol.pricing_formula;
    protocol.pricing_source = "user_workbook_explicit_sale";
    protocol.pricing_source_reference = target.cell;
  }
  entry.configuration.adminNotes = target.unit === "output_second"
    ? `价格源：用户工作簿 ${target.cell}；成本 ¥${target.cost}/输出秒，显式销售价 ¥${target.sale}/输出秒；不得按百分比重算。`
    : `价格源：用户工作簿 ${target.cell}；成本 ¥${target.cost}/次，显式销售价 ¥${target.sale}/次（10秒）；不得按百分比重算。`;
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
  assert.equal(preview.preview?.diff?.changed, true, `${releaseId}:EMPTY_DIFF`);
  const published = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
  assert.equal(published.release?.status, "published", `${releaseId}:PUBLISH_FAILED`);
  assert.equal(published.release?.is_current, true, `${releaseId}:NOT_CURRENT`);
  return {
    id: releaseId,
    version: Number(published.release?.release_version || 0),
    snapshotSha256: String(published.release?.snapshot_sha256 || ""),
    previewSha256,
    changedModels: preview.preview?.diff?.models?.changed?.map((entry) => entry.key) || [],
  };
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-explicit-video-prices"), "EXPLICIT_VIDEO_PRICE_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };

  const actualWorkbookSha256 = await workbookSha256();
  assert.equal(actualWorkbookSha256, EXPECTED_WORKBOOK_SHA256, "WORKBOOK_IDENTITY_CHANGED");

  const overview = await requestJson(origin, headers, "/api/admin/model-pool-releases");
  const current = overview.current;
  const baseline = (overview.releases || []).find(
    (release) => Number(release.release_version) === BASELINE_RELEASE_VERSION,
  );
  assert.ok(current?.snapshot && current?.id, "CURRENT_MODEL_POOL_RELEASE_REQUIRED");
  assert.ok(baseline?.snapshot && baseline?.id, `BASELINE_RELEASE_${BASELINE_RELEASE_VERSION}_REQUIRED`);
  const snapshot = structuredClone(current.snapshot);
  const beforeCurrentVersion = Number(current.release_version || 0);
  assert.ok(beforeCurrentVersion > BASELINE_RELEASE_VERSION, "CURRENT_RELEASE_MUST_FOLLOW_BASELINE");

  const restored = [];
  for (const id of RESTORE_TARGET_IDS) {
    const currentEntry = entryById(snapshot, id);
    const baselineEntry = entryById(baseline.snapshot, id);
    assert.ok(currentEntry, `${id}:CURRENT_ENTRY_MISSING`);
    assert.ok(baselineEntry, `${id}:BASELINE_ENTRY_MISSING`);
    const before = safePriceSummary(currentEntry);
    restorePreMarkupPrice(currentEntry, baselineEntry);
    const after = safePriceSummary(currentEntry);
    const expected = safePriceSummary(baselineEntry);
    sameJson(after.cost, expected.cost, `${id}:BASELINE_COST_NOT_RESTORED`);
    sameJson(after.sale, expected.sale, `${id}:BASELINE_SALE_NOT_RESTORED`);
    sameJson(after.resolutionCostPrices, expected.resolutionCostPrices, `${id}:BASELINE_TIER_COST_NOT_RESTORED`);
    sameJson(after.resolutionSalePrices, expected.resolutionSalePrices, `${id}:BASELINE_TIER_SALE_NOT_RESTORED`);
    restored.push({ id, before, after });
  }

  const workbookModels = [];
  for (const target of WORKBOOK_TARGETS) {
    const entry = entryById(snapshot, target.id);
    assert.ok(entry, `${target.id}:CURRENT_ENTRY_MISSING`);
    const before = safePriceSummary(entry);
    applyWorkbookPrice(entry, target);
    const after = safePriceSummary(entry);
    closeTo(after.cost, target.cost, `${target.id}:WORKBOOK_COST`);
    closeTo(after.sale, target.sale, `${target.id}:WORKBOOK_SALE`);
    closeTo(after.resolutionCostPrices[target.resolution], target.cost, `${target.id}:WORKBOOK_TIER_COST`);
    closeTo(after.resolutionSalePrices[target.resolution], target.sale, `${target.id}:WORKBOOK_TIER_SALE`);
    workbookModels.push({
      id: target.id,
      cell: target.cell,
      billingUnit: target.unit,
      before,
      after,
    });
  }

  const draft = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({
      action: "draft",
      snapshot,
      changeNote: "纠正视频定价口径：工作簿三项使用显式销售价；撤销误套用的全局成本加价20%，保留协议、验收门与排序",
    }),
  });
  const releaseId = String(draft.release?.id || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "CORRECTION_RELEASE_ID_MISSING");
  const published = await validatePreviewPublish(origin, headers, releaseId);

  const inventory = await requestJson(origin, headers, "/api/admin/models");
  for (const target of WORKBOOK_TARGETS) {
    const model = (inventory.models || []).find((entry) => entry.id === target.id);
    assert.ok(model, `${target.id}:ADMIN_READBACK_MISSING`);
    closeTo(model.cost_price, target.cost, `${target.id}:ADMIN_COST_READBACK`);
    closeTo(model.cost_per_use ?? model.price_per_use, target.sale, `${target.id}:ADMIN_SALE_READBACK`);
    closeTo(model.api_protocol_config?.resolution_cost_prices?.[target.resolution], target.cost, `${target.id}:ADMIN_TIER_COST_READBACK`);
    closeTo(model.api_protocol_config?.resolution_prices?.[target.resolution], target.sale, `${target.id}:ADMIN_TIER_SALE_READBACK`);
    assert.equal(model.api_protocol_config?.pricing_markup_percent, undefined, `${target.id}:MARKUP_METADATA_REMAINS`);
    assert.equal(model.api_protocol_config?.pricing_formula, undefined, `${target.id}:FORMULA_METADATA_REMAINS`);
  }
  for (const id of RESTORE_TARGET_IDS) {
    const model = (inventory.models || []).find((entry) => entry.id === id);
    const baselineEntry = entryById(baseline.snapshot, id);
    const expected = safePriceSummary(baselineEntry);
    assert.ok(model, `${id}:ADMIN_READBACK_MISSING`);
    closeTo(model.cost_price, expected.cost, `${id}:ADMIN_BASELINE_COST_READBACK`);
    closeTo(model.cost_per_use ?? model.price_per_use, expected.sale, `${id}:ADMIN_BASELINE_SALE_READBACK`);
    sameJson(
      object(model.api_protocol_config?.resolution_cost_prices),
      expected.resolutionCostPrices,
      `${id}:ADMIN_BASELINE_TIER_COST_READBACK`,
    );
    sameJson(
      object(model.api_protocol_config?.resolution_prices),
      expected.resolutionSalePrices,
      `${id}:ADMIN_BASELINE_TIER_SALE_READBACK`,
    );
  }

  const publicSurfaces = [];
  for (const surface of ["storyboard-workbench", "video-page"]) {
    const catalog = await requestJson(origin, { Authorization: `Bearer ${token}` }, `/api/video/models?surface=${surface}`);
    publicSurfaces.push({ surface, modelCount: Array.isArray(catalog.models) ? catalog.models.length : 0 });
  }
  const finalOverview = await requestJson(origin, headers, "/api/admin/model-pool-releases");
  assert.equal(finalOverview.current?.id, published.id, "FINAL_CURRENT_RELEASE_MISMATCH");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    source: {
      workbookPath: WORKBOOK_PATH,
      workbookSha256: actualWorkbookSha256,
      rule: "text_models_true_cost_plus_20_percent_video_models_explicit_sale_per_workbook",
      videoCells: WORKBOOK_TARGETS.map(({ id, cell, cost, sale, unit }) => ({ id, cell, cost, sale, unit })),
    },
    baselineRelease: {
      id: baseline.id,
      version: BASELINE_RELEASE_VERSION,
      snapshotSha256: baseline.snapshot_sha256,
    },
    previousCurrentRelease: {
      id: current.id,
      version: beforeCurrentVersion,
      snapshotSha256: current.snapshot_sha256,
    },
    publishedRelease: published,
    workbookModels,
    restoredModels: restored,
    publicSurfaces,
    preservedScope: "all_non_price_fields_cloned_from_latest_current_release",
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    passed: report.passed,
    checkedAt: report.checkedAt,
    baselineRelease: report.baselineRelease,
    previousCurrentRelease: report.previousCurrentRelease,
    publishedRelease: report.publishedRelease,
    workbookModels: workbookModels.map(({ id, cell, after }) => ({ id, cell, cost: after.cost, sale: after.sale })),
    restoredModelCount: restored.length,
    publicSurfaces,
    evidencePath: EVIDENCE_PATH,
    providerRequests: 0,
    paidGenerationRequests: 0,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
