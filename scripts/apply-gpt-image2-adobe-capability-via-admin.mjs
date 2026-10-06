#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const modelId = "pending-cover-model-gpt-image-2-adobe-mid";
const outputDir = path.resolve(".codex-evidence/gpt-image2-adobe-capability-fix-20260922");

async function json(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, body?.error || `${pathname} failed with ${response.status}`);
  return body;
}

function publicSnapshot(model) {
  const config = model.api_protocol_config || {};
  return {
    id: model.id,
    active: model.is_active === true,
    hidden: model.is_hidden === true,
    credentialConfigured: model.api_key_configured === true,
    resolutions: config.resolution_options,
    resolutionCosts: config.resolution_cost_prices,
    resolutionPrices: config.resolution_prices,
    defaultResolution: config.default_resolution,
    activationState: config.activation_state,
  };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  const identity = await json("/api/auth/me");
  assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");

  const beforeList = await json("/api/admin/cover-models");
  const before = beforeList.models?.find((model) => model.id === modelId);
  assert.ok(before, "GPT_IMAGE2_ADOBE_GROUP_MISSING");
  assert.equal(before.api_key_configured, true, "GPT_IMAGE2_ADOBE_CREDENTIAL_MISSING");
  const currentConfig = before.api_protocol_config || {};
  const nextConfig = {
    ...currentConfig,
    resolution_options: ["1K", "2K"],
    default_resolution: "2K",
    resolution_cost_prices: { "1K": 0.05, "2K": 0.05 },
    resolution_prices: { "1K": 0.10, "2K": 0.10 },
    activation_state: "pending_real_canary",
    capability_evidence: "2026-09-22: 1K platform UI completed; 4K timed out with unknown upstream result and was withdrawn",
  };

  await json("/api/admin/models", {
    method: "PUT",
    body: JSON.stringify({
      model_type: "drawing",
      id: modelId,
      api_protocol_config: nextConfig,
      is_active: false,
    }),
  });

  const afterList = await json("/api/admin/cover-models");
  const after = afterList.models?.find((model) => model.id === modelId);
  assert.ok(after, "GPT_IMAGE2_ADOBE_GROUP_READBACK_MISSING");
  assert.deepEqual(after.api_protocol_config?.resolution_options, ["1K", "2K"]);
  assert.deepEqual(after.api_protocol_config?.resolution_prices, { "1K": 0.10, "2K": 0.10 });
  assert.equal(after.is_active, false, "MODEL_MUST_RETURN_TO_PENDING_AFTER_CAPABILITY_CHANGE");
  assert.equal(after.api_key_configured, true, "MODEL_CREDENTIAL_WAS_LOST");

  await mkdir(outputDir, { recursive: true });
  const report = {
    appliedAt: new Date().toISOString(),
    origin,
    modelId,
    before: publicSnapshot(before),
    after: publicSnapshot(after),
    secretsPersistedInReport: false,
  };
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ success: true, modelId, resolutions: ["1K", "2K"], active: false, report: path.join(outputDir, "report.json") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "GPT_IMAGE2_ADOBE_CAPABILITY_UPDATE_FAILED");
    process.exitCode = 1;
  });
}
