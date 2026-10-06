#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MODEL_ID = "veo-3-1-fast-chC";
const OLD_MODEL_NAME = "veo3.1-fast";
const NEW_MODEL_NAME = "veo_3_1-fl";
const EVIDENCE = path.resolve(".codex-evidence/model-chain-audit-20261006/gaorui-veo31-fl-model-id-update.json");

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
  assert.equal(validated.release?.status, "validated", "RELEASE_VALIDATION_FAILED");
  const preview = await requestJson(origin, headers, `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "PREVIEW_HASH_MISSING");
  const published = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
  assert.equal(published.release?.status, "published", "RELEASE_PUBLISH_FAILED");
  assert.equal(published.release?.is_current, true, "RELEASE_NOT_CURRENT");
  return { id: releaseId, version: Number(published.release?.release_version || 0) };
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-gaorui-veo31-fl-docs"), "OFFICIAL_DOC_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_STEP_UP_SESSION_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };

  const inventory = await requestJson(origin, headers, "/api/admin/models");
  const before = (inventory.models || []).find((model) => model.id === MODEL_ID);
  assert.ok(before, "VEO_MODEL_NOT_FOUND");
  assert.equal(before.model_name, OLD_MODEL_NAME, "VEO_OLD_MODEL_NAME_CHANGED");
  assert.equal(before.protocol_type, "gaorui_video", "VEO_PROTOCOL_MISMATCH");
  assert.equal(new URL(before.api_endpoint).hostname, "gaorui.cc", "VEO_ENDPOINT_MISMATCH");
  assert.equal(Boolean(before.supports_image_input), true, "VEO_IMAGE_INPUT_REQUIRED");
  assert.equal(Number(before.duration_seconds), 8, "VEO_FIXED_DURATION_REQUIRED");

  const staged = await requestJson(origin, headers, "/api/admin/models", {
    method: "PUT",
    body: JSON.stringify({
      model_type: "video",
      id: MODEL_ID,
      model_name: NEW_MODEL_NAME,
      admin_notes: `${String(before.admin_notes || "").trim()}\n2026-10-06 根据高瑞 Veo 3.1 官方文档修正为图生视频首尾帧模型 veo_3_1-fl；JSON /v1/videos，images 1~2 张，固定 8 秒。`.trim(),
    }),
  });
  assert.equal(staged.staged, true, "VEO_UPDATE_NOT_STAGED");
  assert.equal(staged.published, false, "VEO_UPDATE_UNEXPECTED_AUTO_PUBLISH");
  const releaseId = String(staged.result?.release?.id || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "VEO_RELEASE_ID_MISSING");
  const release = await validatePreviewPublish(origin, headers, releaseId);

  const afterInventory = await requestJson(origin, headers, "/api/admin/models");
  const after = (afterInventory.models || []).find((model) => model.id === MODEL_ID);
  assert.equal(after?.model_name, NEW_MODEL_NAME, "VEO_MODEL_NAME_READBACK_FAILED");
  assert.equal(after?.protocol_type, "gaorui_video", "VEO_PROTOCOL_READBACK_FAILED");
  assert.equal(Boolean(after?.supports_image_input), true, "VEO_IMAGE_INPUT_READBACK_FAILED");
  assert.ok(after?.api_protocol_config?.__model_activation_gate, "VEO_REVALIDATION_GATE_REQUIRED");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    modelId: MODEL_ID,
    oldModelName: OLD_MODEL_NAME,
    newModelName: NEW_MODEL_NAME,
    protocolType: "gaorui_video",
    providerEndpointHost: "gaorui.cc",
    officialDocs: "https://gaoruitech.apifox.cn/doc-8981138",
    officialContract: {
      submit: "POST /v1/videos application/json",
      images: "required 1-2 public URLs",
      durationSeconds: 8,
      resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16"],
    },
    release,
    activationGate: "revalidation_required",
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  await mkdir(path.dirname(EVIDENCE), { recursive: true });
  await writeFile(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
