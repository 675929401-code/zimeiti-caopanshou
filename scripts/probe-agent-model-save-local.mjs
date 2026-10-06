#!/usr/bin/env node
import assert from "node:assert/strict";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token && stepUpToken, "LOCAL_ADMIN_STEP_UP_REQUIRED");

const headers = {
  Authorization: `Bearer ${token}`,
  "x-admin-step-up": stepUpToken,
  "Content-Type": "application/json",
};

async function request(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

const [agentsResult, modelsResult] = await Promise.all([
  request("/api/admin/agents?include_configuration=1"),
  request("/api/llm-models?admin=1"),
]);
assert.ok(agentsResult.ok, `AGENTS_READ_FAILED_${agentsResult.status}`);
assert.ok(modelsResult.ok, `MODELS_READ_FAILED_${modelsResult.status}`);

const requestedAgentId = process.argv.find((argument) => argument.startsWith("--agent-id="))?.slice("--agent-id=".length) || "";
const requestedModel = process.argv.find((argument) => argument.startsWith("--model="))?.slice("--model=".length) || "claude-opus-5-5";
const agents = Array.isArray(agentsResult.body.agents) ? agentsResult.body.agents : [];
const models = Array.isArray(modelsResult.body.models) ? modelsResult.body.models : [];
const agent = requestedAgentId
  ? agents.find((entry) => String(entry.id) === requestedAgentId)
  : agents.find((entry) => entry.source === "llm" && entry.model_id && entry.user_access !== "hidden");
assert.ok(agent, "REVERSIBLE_BOUND_LLM_AGENT_REQUIRED");
const target = models.find((entry) => String(entry.model_name) === requestedModel && String(entry.id) !== String(agent.model_id))
  || models.find((entry) => String(entry.id) !== String(agent.model_id));
assert.ok(target, "ALTERNATE_TEXT_MODEL_REQUIRED");

const originalBinding = { model_id: agent.model_id, model: agent.model };
const uiPayload = {
  ...agent,
  agentId: agent.id,
  model_id: target.id,
  model: target.model_name || target.name,
  proxy_url: target.api_endpoint || target.proxy_url || "",
  coze_coding_api_token: "",
  cost_per_message: target.cost_per_use || 10,
  base_fee: target.cost_price || 0,
  token_billing_enabled: Boolean(target.token_billing_enabled || (target.input_cost_per_million != null && target.output_cost_per_million != null)),
  input_cost_per_million: target.input_cost_per_million ?? undefined,
  output_cost_per_million: target.output_cost_per_million ?? undefined,
  cached_cost_per_million: target.cached_cost_per_million ?? undefined,
  profit_margin: target.profit_margin ?? undefined,
  token_rounding_unit: target.token_rounding_unit || 0,
  deep_thinking_type: target.deep_thinking_type || 0,
  deduct_deep_think: target.deduct_deep_think ?? 1,
  max_context_rounds: target.max_context_rounds || 0,
  max_context_tokens: target.max_context_tokens || 0,
  max_reply_tokens: target.max_reply_tokens || 0,
  timeout: target.timeout || 300,
  enable_web_search: target.enable_web_search || false,
  temperature: target.temperature ?? undefined,
  response_format: target.response_format ?? undefined,
  frequency_limit: target.frequency_limit ?? 50,
  image_parsing: target.image_parsing || "none",
  file_parsing: target.file_parsing || "none",
  preset_fields: Array.isArray(agent.preset_fields) && agent.preset_fields.length > 0 ? agent.preset_fields : null,
};
delete uiPayload.id;

let changed = false;
let saveResult;
let readback;
let restoreResult;
try {
  saveResult = await request("/api/admin/agents", { method: "PUT", body: JSON.stringify(uiPayload) });
  changed = saveResult.ok;
  if (changed) {
    readback = await request("/api/admin/agents?include_configuration=1");
  }
} finally {
  if (changed) {
    restoreResult = await request("/api/admin/agents", {
      method: "PUT",
      body: JSON.stringify({ agentId: agent.id, model_id: originalBinding.model_id }),
    });
    assert.ok(restoreResult.ok, `ORIGINAL_BINDING_RESTORE_FAILED_${restoreResult.status}`);
  }
}

const rebound = readback?.body?.agents?.find((entry) => String(entry.id) === String(agent.id));
console.log(JSON.stringify({
  agent: { id: agent.id, name: agent.name, avatar: agent.avatar ? "configured" : "empty", cover: agent.cover_url ? "configured" : "empty" },
  originalBinding,
  target: { id: target.id, model: target.model_name },
  uiPayloadSave: { ok: Boolean(saveResult?.ok), status: saveResult?.status, code: saveResult?.body?.code || null, error: saveResult?.body?.error || null },
  readback: rebound ? { model_id: rebound.model_id, model: rebound.model } : null,
  restored: Boolean(restoreResult?.ok),
}, null, 2));
