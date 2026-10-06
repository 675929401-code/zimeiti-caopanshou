#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const catalogPath = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/video-storyboard-catalog-after-token-gate.json",
);
const evidencePath = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/video-token-billing-gate-live.json",
);
const internalIds = [
  "secure-skill-doubao-seedance-2-0-g37",
  "secure-skill-doubao-seedance-2-0-fast-g37",
  "secure-skill-doubao-seedance-2-5-g37",
];

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const mapping = new Map(catalog.models.map((model) => [model.internalId, model.publicId]));
const results = [];

for (const internalId of internalIds) {
  const publicId = mapping.get(internalId);
  assert.ok(publicId, `${internalId}:PUBLIC_ID_MISSING`);
  const clientRequestId = `token-gate-${internalId}-${Date.now()}`.slice(0, 120);
  const response = await fetch(`${origin}/api/video/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model_id: publicId,
      prompt: "仅验证计费适配门禁；不得提交供应商任务。",
      duration: 4,
      aspect_ratio: "16:9",
      resolution: "720p",
      surface: "storyboard-workbench",
      client_request_id: clientRequestId,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 409, `${internalId}:EXPECTED_409`);
  assert.equal(body.error_code, "VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED", `${internalId}:WRONG_ERROR_CODE`);
  assert.equal(body.task_submitted, false, `${internalId}:TASK_MUST_NOT_SUBMIT`);
  assert.equal(Number(body.price), 0, `${internalId}:PRICE_MUST_BE_ZERO`);

  const status = await fetch(
    `${origin}/api/video/request-status?clientRequestId=${encodeURIComponent(clientRequestId)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) },
  );
  const statusBody = await status.json().catch(() => ({}));
  assert.equal(status.status, 200, `${internalId}:REQUEST_STATUS_HTTP`);
  assert.equal(statusBody.found, false, `${internalId}:NO_RESERVATION_EXPECTED`);
  assert.equal(statusBody.canResubmit, true, `${internalId}:REQUEST_KEY_MUST_REMAIN_UNUSED`);
  results.push({
    internalId,
    publicId,
    generateHttp: response.status,
    errorCode: body.error_code,
    taskSubmitted: body.task_submitted,
    quotedPrice: Number(body.price),
    requestStatusHttp: status.status,
  });
}

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  origin,
  results,
  providerRequests: 0,
  paidGenerationRequests: 0,
  taskReservations: 0,
  walletOperations: 0,
};
await fs.mkdir(path.dirname(evidencePath), { recursive: true });
await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
