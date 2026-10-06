#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-google-image-protocol-update.json",
);
const TARGETS = [
  { id: "gemini-3-1-flash-image-chA", modelName: "gemini-3.1-flash-image" },
  { id: "gemini-3-0-pro-image-chA", modelName: "gemini-3.0-pro-image" },
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
  const preview = await requestJson(origin, headers, `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
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
  assert.ok(args.includes("--confirm-secure-skill-google-image-protocol"), "EXPLICIT_PROTOCOL_CONFIRMATION_REQUIRED");
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
    assert.equal(before.provider, "secure_skill_chat", `${target.modelName}:PROVIDER_MISMATCH`);
    assert.equal(new URL(before.api_endpoint).hostname, "token.secure-skill.com", `${target.modelName}:ENDPOINT_MISMATCH`);
    if (before.api_protocol_config?.protocol === "google_generate_content"
      && before.api_protocol_config?.submit_path === "/v1beta/models/{model}:generateContent") {
      releases.push({ modelName: target.modelName, alreadyConfigured: true });
      continue;
    }
    const nextProtocol = {
      ...withoutActivationGate(before.api_protocol_config),
      protocol: "google_generate_content",
      adapter_contract: "secure_skill_google_generate_content_v1",
      submit_path: "/v1beta/models/{model}:generateContent",
      response_transport: "google_candidates_inline_data",
      reference_transport: "chat_inline_data",
      documentation_url: "https://token.secure-skill.com/docs#flow-images",
    };
    const staged = await requestJson(origin, headers, "/api/admin/models", {
      method: "PUT",
      body: JSON.stringify({
        model_type: "drawing",
        id: target.id,
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
    assert.equal(after?.api_protocol_config?.protocol, "google_generate_content", `${target.modelName}:PROTOCOL_READBACK`);
    assert.equal(after?.api_protocol_config?.submit_path, "/v1beta/models/{model}:generateContent", `${target.modelName}:SUBMIT_PATH_READBACK`);
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    providerEndpoint: "https://token.secure-skill.com",
    documentation: "https://token.secure-skill.com/docs#flow-images",
    models: TARGETS.map((target) => ({ ...target, protocol: "google_generate_content", publicationState: "revalidation_required" })),
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
