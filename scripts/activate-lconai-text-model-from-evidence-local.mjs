#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const TARGETS = new Map([
  ["gpt-6.1-sol", {
    id: "76b48548-6542-4908-a9f7-10835d2528bb",
    name: "GPT-6.1 Sol · LConAI G2",
  }],
  ["claude-opus-5-5", {
    id: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
    name: "Claude Opus 5.5 · LConAI Claude Max",
  }],
  ["claude-sonnet-5-5", {
    id: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
    name: "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
  }],
]);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  return String(args.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

async function requestJson(origin, headers, pathname, options = {}) {
  const response = await fetch(origin + pathname, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}:HTTP_${response.status}:${body.code || body.error || "UNKNOWN"}`);
  return body;
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-current-validation-evidence"), "CURRENT_VALIDATION_EVIDENCE_CONFIRMATION_REQUIRED");
  const modelName = argumentValue(args, "model");
  const target = TARGETS.get(modelName);
  assert.ok(target, "SUPPORTED_MODEL_ARGUMENT_REQUIRED");

  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_STEP_UP_RUNTIME_REQUIRED");
  const headers = { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp };

  const inventory = await requestJson(origin, headers, "/api/admin/models");
  const matches = (Array.isArray(inventory.models) ? inventory.models : []).filter((model) => (
    model?.model_type === "text"
      && String(model?.id || "") === target.id
      && String(model?.name || "") === target.name
  ));
  assert.equal(matches.length, 1, "TARGET_MODEL_COUNT_MISMATCH");

  const activated = await requestJson(origin, headers, "/api/admin/models/activate", {
    method: "POST",
    body: JSON.stringify({ id: target.id, model_type: "text" }),
  });
  assert.equal(activated.activated, true, "MODEL_ACTIVATION_FAILED");
  assert.equal(activated.model?.is_active, true, "ACTIVE_FLAG_REQUIRED");
  assert.equal(activated.model?.is_hidden, false, "VISIBLE_MODEL_REQUIRED");
  assert.equal(activated.model?.user_access, "available", "AVAILABLE_ACCESS_REQUIRED");
  assert.match(String(activated.evidence_id || ""), /^[a-f0-9-]{36}$/iu, "VALIDATION_EVIDENCE_ID_REQUIRED");

  console.log(JSON.stringify({
    passed: true,
    checkedAt: new Date().toISOString(),
    modelId: target.id,
    modelName,
    endpoint: "https://n.lconai.com",
    activated: true,
    idempotent: activated.idempotent === true,
    evidenceId: activated.evidence_id,
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
