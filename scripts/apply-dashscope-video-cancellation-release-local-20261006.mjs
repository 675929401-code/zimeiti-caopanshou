#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/video-cancellation-dashscope-r857-20261006/report.json",
);
const OFFICIAL_DOCS = "https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks";
const TARGETS = [
  { id: "dashscope-wan2-2-s2v", protocol: "dashscope_wan_s2v" },
  { id: "videoretalk-dashscope", protocol: "dashscope_video_retalk" },
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

function protocolConfigFromPoolEntry(entry) {
  return entry?.configuration?.protocolConfig || entry?.capabilities?.protocol || {};
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-dashscope-docs"), "OFFICIAL_DOC_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_STEP_UP_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };

  const inventory = await requestJson(origin, headers, "/api/admin/models");
  const physical = TARGETS.map((target) => {
    const model = (inventory.models || []).find((entry) => entry.id === target.id);
    assert.ok(model, `${target.id}:MODEL_NOT_FOUND`);
    assert.equal(model.protocol_type, target.protocol, `${target.id}:PROTOCOL_MISMATCH`);
    assert.equal(new URL(model.api_endpoint).hostname, "dashscope.aliyuncs.com", `${target.id}:ENDPOINT_MISMATCH`);
    assert.equal(model.api_protocol_config?.supports_remote_cancel, true, `${target.id}:PHYSICAL_CAPABILITY_NOT_REPAIRED`);
    return model;
  });

  const beforeOverview = await requestJson(origin, headers, "/api/admin/model-pool-releases");
  const beforeCurrent = beforeOverview.current;
  assert.ok(beforeCurrent?.id && beforeCurrent?.snapshot?.models, "CURRENT_MODEL_POOL_REQUIRED");
  const beforePoolState = Object.fromEntries(TARGETS.map((target) => {
    const entry = beforeCurrent.snapshot.models.find((model) => model.kind === "video" && model.id === target.id);
    assert.ok(entry, `${target.id}:CURRENT_POOL_ENTRY_MISSING`);
    return [target.id, protocolConfigFromPoolEntry(entry).supports_remote_cancel === true];
  }));

  const staged = await requestJson(origin, headers, "/api/admin/models", {
    method: "PUT",
    body: JSON.stringify({
      model_type: "video",
      id: physical[0].id,
      api_protocol_config: physical[0].api_protocol_config,
    }),
  });
  assert.equal(staged.staged, true, "DASHSCOPE_CAPABILITY_NOT_STAGED");
  assert.equal(staged.published, false, "DASHSCOPE_CAPABILITY_UNEXPECTED_AUTO_PUBLISH");
  const releaseId = String(staged.result?.release?.id || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "DASHSCOPE_RELEASE_ID_MISSING");

  const validated = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  });
  assert.equal(validated.release?.status, "validated", "DASHSCOPE_RELEASE_VALIDATION_FAILED");
  const previewEnvelope = await requestJson(
    origin,
    headers,
    `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`,
  );
  const preview = previewEnvelope.preview;
  const previewSha256 = String(preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "DASHSCOPE_PREVIEW_HASH_MISSING");
  assert.deepEqual(preview?.diff?.models?.added || [], [], "UNRELATED_MODEL_ADDITION_BLOCKED");
  assert.deepEqual(preview?.diff?.models?.removed || [], [], "UNRELATED_MODEL_REMOVAL_BLOCKED");
  const changedKeys = (preview?.diff?.models?.changed || []).map((entry) => String(entry.key)).sort();
  const allowedKeys = TARGETS.map((target) => `video:${target.id}`).sort();
  assert.deepEqual(changedKeys, allowedKeys, `UNRELATED_MODEL_CHANGES_BLOCKED:${changedKeys.join(",")}`);

  const published = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
  assert.equal(published.release?.status, "published", "DASHSCOPE_RELEASE_PUBLISH_FAILED");
  assert.equal(published.release?.is_current, true, "DASHSCOPE_RELEASE_NOT_CURRENT");

  const afterOverview = await requestJson(origin, headers, "/api/admin/model-pool-releases");
  assert.equal(afterOverview.current?.id, releaseId, "DASHSCOPE_CURRENT_RELEASE_READBACK_MISMATCH");
  const afterPoolState = Object.fromEntries(TARGETS.map((target) => {
    const entry = afterOverview.current.snapshot.models.find((model) => model.kind === "video" && model.id === target.id);
    assert.ok(entry, `${target.id}:PUBLISHED_POOL_ENTRY_MISSING`);
    const enabled = protocolConfigFromPoolEntry(entry).supports_remote_cancel === true;
    assert.equal(enabled, true, `${target.id}:PUBLISHED_CAPABILITY_READBACK_FAILED`);
    return [target.id, enabled];
  }));

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    officialDocs: OFFICIAL_DOCS,
    officialContract: {
      cancel: "POST /api/v1/tasks/{task_id}/cancel",
      confirmation: "GET /api/v1/tasks/{task_id}",
      terminalStatus: "CANCELED",
      providerRestriction: "PENDING tasks only",
    },
    beforeRelease: { id: beforeCurrent.id, version: beforeCurrent.release_version, capability: beforePoolState },
    publishedRelease: { id: releaseId, version: published.release.release_version, capability: afterPoolState },
    changedKeys,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
    secretValuesWrittenToEvidence: false,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
