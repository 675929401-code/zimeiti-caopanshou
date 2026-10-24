import assert from "node:assert/strict";
import fs from "node:fs";
import { LLM_PROVIDER_PRESETS, getLlmProviderPreset } from "../src/lib/llm-provider-presets";
import { canonicalLlmProtocolConfig, llmProxyBindingConfig, resolveLlmProviderBinding } from "../src/lib/llm-provider-contract";
import { assertLlmValidationConfigurationUnchanged, assertFreshLlmModelValidationEvidence, assertLlmEndpointCredentialReplacement, llmDiagnosticScope, llmModelValidationConfigurationHash, pendingLlmConfigurationUpdate } from "../src/lib/llm-model-validation-gate";
import { resolveVideoDetectionDraft } from "../src/lib/model-endpoint";

// This check never discovers private env files and replaces fetch before any
// adapter call. Fixture credentials are synthetic and never printed.
process.env.SERVER_ENV_DISCOVERY_DISABLED = "1";
const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  requests.push({ url: String(url), headers: new Headers(init?.headers), body });
  return new Response(JSON.stringify(String(url).endsWith("/messages")
    ? { id: "fixture", type: "message", model: body.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
    : { model: body.model, choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
};

async function main() {
  const { LLMProxy } = await import("../src/lib/llm-proxy/proxy");
  const key = "synthetic-contract-fixture";
  assert.equal(LLM_PROVIDER_PRESETS.length, 9);
  for (const value of ["secure_skill", "lc_openai_primary", "lc_anthropic", "gaorui"]) {
    const preset = getLlmProviderPreset(value)!;
    assert.equal(preset.verification, "requires_validation");
    for (const auth of ["bearer", "x-api-key"] as const) {
      const binding = resolveLlmProviderBinding({ api_protocol_config: {
        provider: preset.provider, protocol: preset.protocol, auth_scheme: auth, thinking_strategy: "provider_default",
      } });
      const proxy = new LLMProxy({ apiBase: preset.endpoint, apiKey: key, defaultModel: "future-model-free-id", retryCount: 0, ...llmProxyBindingConfig(binding) });
      assert.equal((await proxy.chat({ model: "future-model-free-id", messages: [{ role: "user", content: "OK" }], max_tokens: 256, enable_thinking: false })).content, "OK");
      const request = requests.at(-1)!;
      assert.equal(request.url, preset.endpoint + (preset.protocol === "anthropic_messages" ? "/messages" : "/chat/completions"));
      assert.equal(request.headers.get(auth === "bearer" ? "authorization" : "x-api-key"), auth === "bearer" ? `Bearer ${key}` : key);
      assert.equal(request.headers.has(auth === "bearer" ? "x-api-key" : "authorization"), false);
      assert.equal(request.headers.get("anthropic-version"), preset.protocol === "anthropic_messages" ? "2023-06-01" : null);
      assert.equal(request.body.model, "future-model-free-id");
      assert.equal(request.body.thinking, undefined);
      assert.equal(request.body.auth_scheme, undefined);
      assert.equal(request.body.thinking_strategy, undefined);
    }
  }
  assert.throws(() => resolveLlmProviderBinding({ api_protocol_config: { provider: "custom", protocol: "openai_chat", auth_scheme: "unknown" } }));
  assert.throws(() => resolveLlmProviderBinding({ api_protocol_config: { provider: "custom", protocol: "openai_chat", output_token_field: "other" } }));
  assert.throws(() => resolveLlmProviderBinding({ api_protocol_config: { provider: "custom", protocol: "anthropic_messages", output_token_field: "max_completion_tokens" } }));
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const binding = resolveLlmProviderBinding({ api_protocol_config: { provider: "custom", protocol: "openai_chat", output_token_field: field } });
    const proxy = new LLMProxy({ apiBase: "https://future.invalid/v1", apiKey: key, defaultModel: "arbitrary-new-model", ...llmProxyBindingConfig(binding) });
    await proxy.chat({ model: "arbitrary-new-model", messages: [{ role: "user", content: "OK" }], max_tokens: 256 });
    assert.equal(requests.at(-1)!.body[field], 256);
    assert.equal(requests.at(-1)!.body[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"], undefined);
  }
  assert.throws(() => canonicalLlmProtocolConfig({ api_protocol_config: { provider: "custom", protocol: "anthropic_messages", thinking_strategy: "adaptive_low" } }));
  const adaptive = resolveLlmProviderBinding({ api_protocol_config: { provider: "custom", protocol: "anthropic_messages", thinking_strategy: "adaptive_low", supports_adaptive_thinking: true } });
  const proxy = new LLMProxy({ apiBase: "https://n.lconai.com/v1", apiKey: key, defaultModel: "claude-opus-5-5", ...llmProxyBindingConfig(adaptive) });
  await proxy.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "OK" }], max_tokens: 256, enable_thinking: false });
  assert.deepEqual(requests.at(-1)!.body.thinking, { type: "adaptive" });
  assert.deepEqual(requests.at(-1)!.body.output_config, { effort: "low" });
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    const legacyProxy = new LLMProxy({ apiBase: "https://n.lconai.com/v1", apiKey: key, defaultModel: model, provider: "lconai", protocol: "anthropic_messages", authScheme: "bearer" });
    await legacyProxy.chat({ model, messages: [{ role: "user", content: "OK" }], max_tokens: 256, enable_thinking: false });
    assert.equal(requests.at(-1)!.body.thinking, undefined);
  }
  for (const id of ["storyboard-high-energy-b-v6-adaptive-low-v1", "storyboard-high-energy-b-v8-adaptive-low-v1"] as const) {
    const legacyProxy = new LLMProxy({ apiBase: "https://n.lconai.com/v1", apiKey: key, defaultModel: "claude-opus-5-5", provider: "lconai", protocol: "anthropic_messages", authScheme: "bearer", thinkingStrategy: "provider_default" });
    await legacyProxy.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "OK" }], max_tokens: 256, enable_thinking: false, anthropic_thinking_profile: { id, thinkingMode: "adaptive", effort: "low" } });
    assert.deepEqual(requests.at(-1)!.body.output_config, { effort: "low" });
  }

  const model = { id: "fixture", model_name: "claude-opus-5-5", api_endpoint: "https://n.lconai.com/v1", api_key: key, api_protocol_config: { provider: "lconai", protocol: "anthropic_messages", auth_scheme: "bearer", thinking_strategy: "provider_default" }, max_reply_tokens: 4096, temperature: 0.8, updated_at: "2026-10-15T00:00:00Z", is_active: true, user_access: "available", is_hidden: false };
  const hash = llmModelValidationConfigurationHash(model, key);
  assert.throws(() => assertLlmEndpointCredentialReplacement(model, { api_endpoint: "https://different.invalid/v1" }, undefined), /站点/u);
  assertLlmEndpointCredentialReplacement(model, { api_endpoint: "https://n.lconai.com/v1/other" }, undefined);
  assertLlmEndpointCredentialReplacement(model, { api_endpoint: "https://different.invalid/v1" }, "new-synthetic-key");
  assert.throws(() => assertLlmEndpointCredentialReplacement({ ...model, api_key: "secret://old-fixture-ref" }, { api_endpoint: "https://different.invalid/v1" }, "secret://old-fixture-ref"), /站点/u);
  assert.equal(llmDiagnosticScope({ scope: "saved", model_id: model.id }), "saved");
  assert.equal(llmDiagnosticScope({ model_id: model.id }), "saved");
  assert.equal(llmDiagnosticScope({ model_id: model.id, api_endpoint: model.api_endpoint }), "draft");
  assert.equal(llmDiagnosticScope({ scope: "draft", model_id: model.id }), "draft");
  assert.throws(() => llmDiagnosticScope({ scope: "saved", model_id: model.id, api_protocol_config: model.api_protocol_config }));
  assert.throws(() => llmDiagnosticScope({ scope: "saved" }));
  assert.throws(() => llmDiagnosticScope({ scope: "unknown" }));
  assert.equal(resolveVideoDetectionDraft({ model_name: "new-id" }, model).apiKey, key);
  assert.throws(() => resolveVideoDetectionDraft({ api_endpoint: "https://different.invalid/v1" }, model), /站点/u);
  assert.equal(resolveVideoDetectionDraft({ api_endpoint: "https://different.invalid/v1", api_key: "new-synthetic-key" }, model).apiKey, "new-synthetic-key");
  assertLlmValidationConfigurationUnchanged(model, model, hash, key);
  assert.throws(() => assertLlmValidationConfigurationUnchanged(model, { ...model, updated_at: "2026-10-15T00:00:01Z" }, hash, key));
  assert.throws(() => assertLlmValidationConfigurationUnchanged(model, { ...model, max_reply_tokens: 8192 }, hash, key));
  assert.throws(() => assertLlmValidationConfigurationUnchanged(model, model, hash, key + "-rotated"));
  const evidence = { model_id: model.id, configuration_hash: hash, checked_at: new Date().toISOString() };
  assertFreshLlmModelValidationEvidence(model, key, evidence);
  assert.throws(() => assertFreshLlmModelValidationEvidence({ ...model, max_reply_tokens: 8192 }, key, evidence));
  assert.throws(() => assertFreshLlmModelValidationEvidence({ ...model, api_protocol_config: { ...model.api_protocol_config, auth_scheme: "x-api-key" } }, key, evidence));
  assert.equal(pendingLlmConfigurationUpdate(model, { name: "Metadata only" }).is_active, true);
  const pending = pendingLlmConfigurationUpdate(model, { max_reply_tokens: 8192 });
  assert.equal(pending.is_active, false);
  assert.equal(pending.user_access, "pending_model_activation");
  assert.equal(pending.is_hidden, false);
  assert.equal(pendingLlmConfigurationUpdate({ ...model, is_active: false }, { user_access: "available", name: "Unchanged access metadata" }).is_active, false);
  assert.throws(() => pendingLlmConfigurationUpdate({ ...model, is_active: false, user_access: "pending_model_activation" }, { is_active: true }));
  assert.throws(() => pendingLlmConfigurationUpdate({ ...model, is_active: false, user_access: "pending_model_activation" }, { user_access: "available" }));

  const route = fs.readFileSync("src/app/api/admin/llm-test/route.ts", "utf8");
  assert.match(route, /passed && scope === "saved" && stored\?\.id/u);
  assert.match(route, /assertLlmValidationConfigurationUnchanged/u);
  assert.match(route, /assertPublishedModelPoolEntry\("llm_models", modelId\)/u);
  const activation = fs.readFileSync("src/app/api/admin/models/activate/route.ts", "utf8");
  assert.match(activation, /authorizeAdminCapability\(request, "models\.manage"/u);
  assert.match(activation, /requireStepUp: true/u);
  assert.match(activation, /\.eq\("updated_at", model.updated_at\)/u);
  const admin = fs.readFileSync("src/app/api/admin/models/route.ts", "utf8");
  const textPut = admin.slice(admin.indexOf('const { data: currentTextModel'), admin.indexOf('const { data: currentVideoModel'));
  assert.doesNotMatch(textPut, /updateFields\.is_active = true/u);
  assert.match(textPut, /pendingLlmConfigurationUpdate/u);
  assert.match(textPut, /assertLlmEndpointCredentialReplacement\(currentTextModel, fields, nextApiKey\)/u);
  console.log(JSON.stringify({ passed: true, fixtureAdapterRequests: requests.length, externalProviderCalls: 0, databaseWrites: 0, privateEnvDiscovery: false, cases: ["three-provider-protocol-auth", "arbitrary-model-id", "opus-sonnet-default", "explicit-adaptive-capability", "B6-B8-profile-preservation", "saved-draft-isolation", "cross-origin-key-isolation", "post-dispatch-concurrency", "fingerprint-invalidation", "save-cannot-activate", "catalog-visibility-preserved", "activation-capability-step-up-CAS"] }, null, 2));
}

main().finally(() => { globalThis.fetch = originalFetch; }).catch((error) => { console.error(error); process.exitCode = 1; });
