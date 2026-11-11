import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import vm from "node:vm";
const require = createRequire(import.meta.url);
require("tsx/cjs");
const ts = require("typescript");
const vision = require("../src/lib/server/llm-vision-validation.ts");
const ordinary = require("../src/lib/llm-model-validation-gate.ts");
const checks = [], source = readFileSync(new URL("../src/app/api/admin/llm-test/route.ts", import.meta.url), "utf8");
let networkCalls = 0;
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network access"); };
async function test(name, run) { await run(); checks.push(name); }
const id = "00000000-0000-4000-8000-000000000001", actor = "00000000-0000-4000-8000-000000000002";
const stored = () => ({ id, model_name: "fixture-model", api_endpoint: "https://fixture.invalid/v1", api_key: "fixture-only-reference",
  image_parsing: "none", updated_at: "2026-11-06T00:00:00Z", billing_mode: "token", token_billing_enabled: true,
  input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0.2, profit_margin: 10,
  max_context_rounds: 5, max_context_tokens: 4000, max_reply_tokens: 512, timeout: 30, deep_thinking_type: 0,
  enable_web_search: false, api_protocol_config: { provider: "fixture", protocol: "openai_chat", authScheme: "bearer" } });
const request = (patch = {}) => ({ scope: "draft", model_id: id, model_type: "text", capability: "vision", image_parsing: "gpt_vision", ...patch });
class PlatformConfigurationError extends Error { constructor(code, message) { super(message); this.code = code; } }
const response = (data, status = 200) => ({ status, headers: { set() {} }, async json() { return data; } });
function compile(code, mocks = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const context = vm.createContext({ module, exports: module.exports, require: name => {
    if (!(name in mocks)) throw new Error(`Unmocked import: ${name}`); return mocks[name];
  }, console, Buffer, URL, crypto: globalThis.crypto, Date, ...globals });
  vm.runInContext(output, context); return module.exports;
}
function harness(options = {}) {
  const state = { reads: 0, proxyCalls: 0, writes: [], publishedChecks: 0, secrets: 0, challenge: null, proxyConfig: null };
  const row = { ...stored(), ...(options.row || {}) };
  const db = { from(table) {
    const builder = { select() { return builder; }, eq() { return builder; },
      async maybeSingle() { assert.equal(table, "llm_models"); state.reads++;
        return { data: state.reads > 1 ? { ...row, ...(options.after || {}) } : { ...row }, error: null }; },
      upsert(value) { assert.equal(table, "llm_model_validation_evidence"); state.writes.push(value); return builder; },
      async single() { return options.persistFailure ? { error: { message: "fixture" }, data: null } : { error: null, data: { id: "fixture-evidence", checked_at: new Date().toISOString() } }; },
    }; return builder;
  } };
  class LLMProxy {
    constructor(config) { state.proxyConfig = config; }
    async chat(input) { state.proxyCalls++; assert.equal(state.proxyConfig.retryCount, 0);
      if (options.throwProvider) throw new Error("fixture provider failure; never expose this body");
      if (!state.challenge) { const expected = input.messages[0].content.match(/Return exactly (.+) and no additional text\./u)[1]; return { content: expected }; }
      const content = options.reply === undefined ? options.badReply ? '{"images":[]}' : JSON.stringify({ images: state.challenge.expected })
        : typeof options.reply === "function" ? options.reply(state.challenge.expected) : options.reply;
      return { content, usage: { prompt_tokens: 100, completion_tokens: 50 }, ...(options.raw ? { raw: options.raw } : {}) };
    }
  }
  const mocks = {
    "node:crypto": require("node:crypto"),
    "next/server": { NextResponse: { json: (body, init) => response(body, init?.status ?? 200) } },
    "@/storage/database/supabase-client": { getSupabaseClient: () => db },
    "@/lib/server/admin-governance-authority": { authorizeAdminCapability: async (_req, capability, config) => {
      assert.equal(capability, "models.manage"); assert.equal(config.requireStepUp, true);
      return options.denied ? { ok: false, response: response({ error: "denied" }, 403) } : { ok: true, actor: { userId: actor } };
    } },
    "@/lib/model-endpoint": { resolveVideoDetectionDraft: (_body, binding) => ({ apiEndpoint: binding.api_endpoint, apiKey: binding.api_key, modelName: binding.model_name }) },
    "@/lib/provider-secret": { resolveProviderSecret: value => { state.secrets++; return String(value); } },
    "@/lib/safe-fetch": { validateSafeUrl: async () => {} },
    "@/lib/llm-proxy/proxy": { LLMProxy }, "@/lib/llm-model-validation-gate": ordinary,
    "@/lib/model-probe-result": { modelProbeFailure: () => ({ diagnosticCode: "fixture" }) },
    "@/lib/llm-provider-contract": { resolveLlmProviderBinding: () => ({}), llmProxyBindingConfig: () => ({ provider: "fixture", protocol: "openai_chat", authScheme: "bearer" }) },
    "@/lib/server/platform-configuration-compatibility": { assertPublishedModelPoolEntry: async () => { state.publishedChecks++; if (options.notPublished) throw new PlatformConfigurationError("MODEL_NOT_IN_CURRENT_POOL", "fixture unpublished"); } },
    "@/lib/server/platform-configuration-admin": { PlatformConfigurationError },
    "@/lib/server/llm-vision-validation": { ...vision, buildVisionChallenge: async () => (state.challenge = await vision.buildVisionChallenge()) },
  };
  const route = compile(source, mocks);
  return { state, async run(body = request()) { const result = await route.POST({ json: async () => body }); return { status: result.status, body: await result.json() }; } };
}

function entry(imageParsing = "none", patch = {}) {
  const row = stored();
  return { id: `llm:${id}`, kind: "agent", name: "fixture", modelName: row.model_name, provider: "fixture", protocol: "openai_chat",
    endpoint: row.api_endpoint, credentialRef: `secret://fixture/model`, catalogState: "enabled", sortOrder: 0,
    capabilities: { deepThinkingType: 0, webSearch: false, imageParsing, protocol: row.api_protocol_config },
    pricing: { billingMode: "token", inputCostPerMillion: 1, outputCostPerMillion: 2, cachedCostPerMillion: 0.2 },
    configuration: { legacyTable: "llm_models", legacyId: id, billingMode: "token", tokenBillingEnabled: true, profitMargin: 10,
      maxContextRounds: 5, maxContextTokens: 4000, maxReplyTokens: 512, timeout: 30, protocolConfig: row.api_protocol_config }, ...patch };
}
const snapshot = models => ({ schema: "model-pool-config/v1", models });

try {
  await test("three random PNGs have pixel-only codes, fresh fixture hashes and strict order checks", async () => {
    const a = await vision.buildVisionChallenge(), b = await vision.buildVisionChallenge();
    assert.equal(a.expected.length, 3); assert.notEqual(a.fixtureSha256, b.fixtureSha256);
    const content = a.messages[1].content, images = content.filter(part => part.type === "image_url");
    assert.equal(images.length, 3);
    assert.equal(a.imageCount, 3);
    assert.deepEqual(a.imageSha256, images.map(image => createHash("sha256").update(Buffer.from(image.image_url.url.split(",")[1], "base64")).digest("hex")));
    for (const image of images) assert.ok(Buffer.from(image.image_url.url.split(",")[1], "base64").subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    const text = a.messages.map(m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("")).join("\n");
    for (const answer of a.expected) assert.ok(!text.includes(answer.code));
    assert.equal(vision.visionChallengePassed(JSON.stringify({ images: a.expected }), a.expected), true);
    for (const bad of ["```json\n{}\n```", JSON.stringify({ images: a.expected.slice(0, 2) }), JSON.stringify({ images: [a.expected[1], a.expected[2], a.expected[0]] }), JSON.stringify({ images: a.expected, extra: true }), JSON.stringify({ images: a.expected.map(x => ({ ...x, extra: 1 })) })])
      assert.equal(vision.visionChallengePassed(bad, a.expected), false);
  });
  await test("strict diagnostics distinguish all six failure classes without changing pass conditions", () => {
    const expected = [{ shape: "circle", color: "red", code: "AB23" }, { shape: "square", color: "blue", code: "CD45" }, { shape: "triangle", color: "green", code: "EF67" }];
    const cases = [
      [" \n", "empty"], ["provider refusal, arbitrary prose", "not_json"],
      [JSON.stringify({ other: [] }), "top_schema"], [JSON.stringify({ images: expected.slice(0, 2) }), "image_count"],
      [JSON.stringify({ images: [{ ...expected[0], extra: "never return this" }, ...expected.slice(1)] }), "item_schema"],
      [JSON.stringify({ images: [{ ...expected[0], code: "ZZ99" }, ...expected.slice(1)] }), "value_mismatch"],
    ];
    for (const [content, failure] of cases) {
      const diagnostic = vision.diagnoseVisionChallenge(content, expected);
      assert.equal(diagnostic.failure, failure); assert.equal(vision.visionChallengePassed(content, expected), false);
      assert.equal(diagnostic.responseLength, content.length); assert.equal(diagnostic.matchBitmap.length, 3);
    }
    const correct = JSON.stringify({ images: expected }), matched = vision.diagnoseVisionChallenge(correct, expected);
    assert.equal(matched.failure, null); assert.equal(vision.visionChallengePassed(correct, expected), true);
    assert.ok(matched.matchBitmap.every(item => item.all));
    const wrongCode = vision.diagnoseVisionChallenge(cases[5][0], expected);
    assert.deepEqual(wrongCode.matchBitmap[0], { shape: true, color: true, code: false, all: false });
    assert.deepEqual(wrongCode.matchBitmap[1], { shape: true, color: true, code: true, all: true });
  });
  await test("fenced JSON is diagnostic-only and never creates visual evidence", async () => {
    const h = harness({ reply: expected => "```json\n" + JSON.stringify({ images: expected }) + "\n```" });
    const result = await h.run(), d = result.body.diagnostics;
    assert.equal(result.body.success, false); assert.equal(d.failure, "not_json"); assert.equal(d.fenced, true);
    assert.equal(d.parseSource, "fenced_diagnostic"); assert.ok(d.matchBitmap.every(item => item.all));
    assert.equal(h.state.writes.length, 0); assert.equal(h.state.proxyCalls, 1);
  });
  await test("diagnostics redact arbitrary provider/expected strings, extra keys, URLs and long secrets", () => {
    const marker = "DO_NOT_EXPOSE_DIAGNOSTIC_PAYLOAD", url = "https://private.invalid/credential", bad = { shape: url, color: marker, code: marker };
    const expected = [{ shape: "circle", color: "red", code: "AB23" }, { shape: "square", color: "blue", code: "CD45" }, { shape: "triangle", color: "green", code: "EF67" }];
    const content = JSON.stringify({ images: [{ ...bad, api_key: marker }, ...expected.slice(1)], secret: marker });
    const d = vision.diagnoseVisionChallenge(content, expected, url), serialized = JSON.stringify(d);
    assert.equal(d.failure, "top_schema"); assert.deepEqual(d.parsed[0], { shape: null, color: null, code: null });
    assert.ok(!serialized.includes(marker)); assert.ok(!serialized.includes(url)); assert.equal(d.finishReason, null);
    const unsafeExpected = vision.diagnoseVisionChallenge(JSON.stringify({ images: expected }), [bad, ...expected.slice(1)]);
    assert.deepEqual(unsafeExpected.expected[0], { shape: null, color: null, code: null });
    assert.ok(!JSON.stringify(unsafeExpected).includes(marker)); assert.ok(!JSON.stringify(unsafeExpected).includes(url));
    assert.equal(vision.diagnoseVisionChallenge("x".repeat(4097), expected).failure, "not_json");
    assert.equal(vision.diagnoseVisionChallenge(JSON.stringify({ images: [...expected, bad] }), expected).parsed.length, 3);
  });
  await test("route receipts include bounded diagnostics, safe finish reason and exact local input hashes", async () => {
    assert.equal(vision.visionFinishReason({ raw: { stop_reason: "end_turn" } }), "end_turn");
    assert.equal(vision.visionFinishReason({ raw: { choices: [{ finish_reason: "https://private.invalid/secret" }] } }), null);
    const h = harness({ raw: { choices: [{ finish_reason: "length" }], secret: "DO_NOT_ECHO_RAW" },
      reply: expected => JSON.stringify({ images: [{ ...expected[0], code: "zz99" }, ...expected.slice(1)] }) });
    const result = await h.run(), d = result.body.diagnostics;
    assert.equal(d.failure, "value_mismatch"); assert.equal(d.parsed[0].code, null); assert.equal(d.finishReason, "length");
    assert.equal(result.body.inputImages.imageCount, 3); assert.deepEqual(result.body.inputImages.imageSha256, h.state.challenge.imageSha256);
    assert.equal(result.body.responseSha256.length, 64); assert.equal(h.state.writes.length, 0);
    assert.ok(!JSON.stringify(result.body).includes("DO_NOT_ECHO_RAW"));
  });
  await test("client prompt, images, URLs, endpoints, credentials, agent IDs and unknown fields are rejected", () => {
    for (const field of ["messages", "images", "url", "api_endpoint", "api_key", "prompt", "agent_id", "unknown"])
      assert.throws(() => vision.parseVisionProbeRequest(request({ [field]: "fixture" })), /仅接受已有模型ID/u);
    assert.throws(() => vision.parseVisionProbeRequest(request({ model_id: "new-id" })));
    assert.throws(() => vision.parseVisionProbeRequest(request({ scope: "saved" })));
    assert.throws(() => vision.parseVisionProbeRequest(request({ image_parsing: "global" })));
  });
  await test("same model text hash and vision hash remain distinct; old text evidence cannot authorize vision", () => {
    const row = stored(), candidate = vision.effectiveVisionBinding(row, "draft"), secret = row.api_key;
    const textHash = ordinary.llmModelValidationConfigurationHash(row, secret), visualHash = vision.visionConfigurationHash(candidate, secret);
    assert.notEqual(textHash, visualHash); assert.equal(textHash, ordinary.llmModelValidationConfigurationHash(candidate, secret));
    assert.throws(() => vision.assertFreshVisionEvidence(candidate, secret, { model_id: id, configuration_hash: textHash, checked_at: new Date().toISOString() }));
    vision.assertFreshVisionEvidence(candidate, secret, { model_id: id, configuration_hash: visualHash, checked_at: new Date().toISOString() });
    assert.throws(() => vision.assertFreshVisionEvidence(candidate, secret, { model_id: actor, configuration_hash: visualHash, checked_at: new Date().toISOString() }));
    assert.throws(() => vision.assertFreshVisionEvidence(candidate, secret, { model_id: id, configuration_hash: visualHash, checked_at: "2000-01-01" }));
    assert.throws(() => ordinary.assertFreshLlmModelValidationEvidence(row, secret, { model_id: id, configuration_hash: visualHash, checked_at: new Date().toISOString() }));
  });
  await test("authorized capability-only draft writes exactly one visual evidence row and no model configuration", async () => {
    const h = harness(), result = await h.run(); assert.equal(result.body.success, true); assert.equal(h.state.proxyCalls, 1); assert.equal(h.state.writes.length, 1);
    const written = h.state.writes[0]; assert.equal(written.model_id, id);
    assert.equal(written.configuration_hash, vision.visionConfigurationHash(vision.effectiveVisionBinding(stored(), "draft"), stored().api_key));
    assert.equal(result.body.fixtureVersion, vision.LLM_VISION_FIXTURE_VERSION);
    assert.equal("expected" in result.body, false); assert.equal("messages" in result.body, false); assert.equal(result.body.billingVerified, false);
  });
  await test("saved vision only accepts an existing saved capability", async () => {
    const body = request({ scope: "saved" }); delete body.image_parsing;
    const absent = harness(); assert.equal((await absent.run(body)).body.success, false); assert.equal(absent.state.proxyCalls, 0);
    const valid = harness({ row: { image_parsing: "gpt_vision" } }); assert.equal((await valid.run(body)).body.success, true);
  });
  await test("step-up denial, unpublished model and client overrides never dispatch or resolve a secret", async () => {
    for (const options of [{ denied: true }, { notPublished: true }]) { const h = harness(options); await h.run(); assert.equal(h.state.proxyCalls, 0); assert.equal(h.state.secrets, 0); }
    const h = harness(); await h.run(request({ messages: [] })); assert.equal(h.state.proxyCalls, 0); assert.equal(h.state.secrets, 0);
  });
  await test("incorrect provider JSON cannot create evidence", async () => {
    const h = harness({ badReply: true }); assert.equal((await h.run()).body.diagnosticCode, "VISION_CHALLENGE_FAILED"); assert.equal(h.state.writes.length, 0); assert.equal(h.state.proxyCalls, 1);
  });
  await test("configuration, capability or credential changes during a paid probe prevent evidence", async () => {
    for (const after of [{ timeout: 31 }, { updated_at: "changed" }, { image_parsing: "gpt_vision" }, { api_key: "fixture-second-reference" }]) {
      const h = harness({ after }); const result = await h.run(); assert.equal(result.body.diagnosticCode, "VALIDATION_CONFIGURATION_CHANGED"); assert.equal(h.state.writes.length, 0); assert.equal(h.state.proxyCalls, 1);
    }
  });
  await test("unknown and evidence-persistence failures never retry, activate or claim billing verified", async () => {
    const unknown = harness({ throwProvider: true }); const result = await unknown.run();
    assert.equal(result.body.outcome, "unknown"); assert.equal(result.body.paidProbeUsed, true); assert.equal(result.body.billingVerified, false); assert.equal(unknown.state.proxyCalls, 1); assert.equal(unknown.state.writes.length, 0);
    assert.ok(!JSON.stringify(result.body).includes("fixture provider failure"));
    const persist = harness({ persistFailure: true }); assert.equal((await persist.run()).body.diagnosticCode, "VISION_EVIDENCE_PERSIST_FAILED"); assert.equal(persist.state.proxyCalls, 1);
  });
  await test("ordinary text route still persists only its original text hash", async () => {
    const h = harness(); const result = await h.run({ scope: "saved", model_id: id, model_type: "text" });
    assert.equal(result.body.success, true); assert.equal(h.state.challenge, null);
    assert.equal(h.state.writes[0].configuration_hash, ordinary.llmModelValidationConfigurationHash(stored(), stored().api_key));
  });
  await test("publish detects disabled-to-enabled vision bypass and existing vision binding changes", () => {
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry()]), snapshot([entry("gpt_vision")])).length, 1);
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry("gpt_vision", { catalogState: "retired" })]), snapshot([entry("gpt_vision")])).length, 1);
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry("gpt_vision")]), snapshot([entry("gpt_vision", { endpoint: "https://different.invalid" })])).length, 1);
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry("gpt_vision")]), snapshot([entry("gpt_vision")])).length, 0);
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry("gpt_vision")]), snapshot([entry("global")])).length, 1);
    assert.throws(() => vision.visionCandidateBinding(entry("gpt_vision"), entry("global"), { ...stored(), image_parsing: "gpt_vision" }));
    assert.equal(vision.visionCapabilityTransitions(snapshot([entry()]), snapshot([entry()])).length, 0);
    for (const patch of [{ endpoint: "https://different.invalid" }, { protocol: "anthropic_messages" }, { credentialRef: "secret://fixture/changed" }, { pricing: { inputCostPerMillion: 999 } }])
      assert.throws(() => vision.visionCandidateBinding(entry(), entry("gpt_vision", patch), stored()), /仅适用于能力单独变更/u);
    assert.throws(() => vision.visionCandidateBinding(undefined, entry("gpt_vision"), stored()));
    assert.equal(vision.visionCandidateBinding(entry(), entry("gpt_vision"), stored()).image_parsing, "gpt_vision");
  });
  await test("compact nullable prices preserve ordinary hash; projection defaults or protocol changes are not silently authorized", () => {
    const raw = { ...stored(), cached_cost_per_million: null, profit_margin: null };
    const before = entry(); delete before.pricing.cachedCostPerMillion; delete before.configuration.profitMargin;
    const after = structuredClone(before); after.capabilities.imageParsing = "gpt_vision";
    const candidate = vision.visionCandidateBinding(before, after, raw);
    assert.equal(ordinary.llmModelValidationConfigurationHash(candidate, raw.api_key), ordinary.llmModelValidationConfigurationHash(raw, raw.api_key));
    const missingContext = structuredClone(before); delete missingContext.configuration.maxContextRounds;
    const changedContext = structuredClone(missingContext); changedContext.capabilities.imageParsing = "gpt_vision";
    const projected = vision.visionCandidateBinding(missingContext, changedContext, { ...raw, max_context_rounds: null });
    assert.equal(projected.max_context_rounds, 12);
    assert.notEqual(ordinary.llmModelValidationConfigurationHash(projected, raw.api_key), ordinary.llmModelValidationConfigurationHash({ ...raw, max_context_rounds: null }, raw.api_key));
    const runtime = { ...raw, api_protocol_config: { ...raw.api_protocol_config, __model_activation_gate: { state: "accepted" } } };
    assert.notEqual(ordinary.llmModelValidationConfigurationHash(vision.visionCandidateBinding(before, after, runtime), raw.api_key), ordinary.llmModelValidationConfigurationHash(runtime, raw.api_key));
  });
  await test("actual central visual gate rejects ordinary evidence, pending credentials and binding combinations", async () => {
    const admin = readFileSync(new URL("../src/lib/server/platform-configuration-admin.ts", import.meta.url), "utf8");
    const gateSource = admin.slice(admin.indexOf("async function assertNewVisionCapabilityEvidence("), admin.indexOf("export async function publishPlatformConfigurationRelease("));
    async function run(options = {}) {
      const before = entry(options.beforeVision ? "gpt_vision" : "none"), after = entry("gpt_vision", options.after || {}), row = { ...stored(), ...(options.beforeVision ? { image_parsing: "gpt_vision" } : {}) };
      const hash = options.textEvidence ? ordinary.llmModelValidationConfigurationHash(row, row.api_key) : vision.visionConfigurationHash({ ...row, image_parsing: "gpt_vision" }, row.api_key);
      const db = { from(table) { const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() {
        return { error: null, data: table === "llm_models" ? row : { model_id: id, configuration_hash: hash, checked_at: new Date().toISOString() } };
      } }; return chain; } };
      const gate = compile(gateSource + "\nexport { assertNewVisionCapabilityEvidence };", {}, {
        release: async () => snapshot([after]), currentRelease: async () => snapshot([before]), snapshotFromRow: (_kind, value) => value,
        credentialMetadata: async () => options.pending ? [{ modelKey: `llm_models:${id}`, credentialRef: after.credentialRef }] : [], getSupabaseAdminClient: () => db,
        PlatformConfigurationError, resolveProviderSecret: value => String(value),
        ...vision, llmModelValidationConfigurationHash: ordinary.llmModelValidationConfigurationHash,
      });
      return gate.assertNewVisionCapabilityEvidence("fixture-release");
    }
    await run(); await assert.rejects(() => run({ textEvidence: true }), /真实三图验证/u);
    await assert.rejects(() => run({ pending: true }), /密钥变更/u);
    await assert.rejects(() => run({ pending: true, beforeVision: true }), /密钥变更/u);
    await assert.rejects(() => run({ after: { endpoint: "https://changed.invalid" } }), /能力单独变更/u);
  });
  await test("actual UI handler treats unexpected JSON as unknown and prevents a second manual submit", async () => {
    const ui = readFileSync(new URL("../src/components/unified-models-tab.tsx", import.meta.url), "utf8");
    const handler = ui.slice(ui.indexOf("  const handleVisionValidation = async"), ui.indexOf("  // ── 删除模型", ui.indexOf("  const handleVisionValidation = async")));
    for (const body of [{}, { error: "gateway" }, null]) {
      const states = {}, locks = { current: new Set() }; let submissions = 0;
      const module = compile(handler + "\nexport { handleVisionValidation };", {}, {
        token: "fixture", canManageModels: true, authHeaders: {}, visionActions: states, textActionLocks: locks,
        window: { confirm: () => true }, setVisionActions: update => Object.assign(states, update(states)),
        fetch: async () => { submissions++; return { ok: false, status: 503, json: async () => body }; },
      });
      await module.handleVisionValidation({ id, name: "fixture", image_parsing: "none" });
      assert.equal(states[id].unknown, true); await module.handleVisionValidation({ id, name: "fixture", image_parsing: "none" });
      assert.equal(submissions, 1);
    }
  });
  await test("central publisher invokes visual gate before atomic publication; UI locks unknown probes", () => {
    const admin = readFileSync(new URL("../src/lib/server/platform-configuration-admin.ts", import.meta.url), "utf8");
    const publisher = admin.slice(admin.indexOf("export async function publishPlatformConfigurationRelease("));
    assert.ok(publisher.indexOf("await assertNewVisionCapabilityEvidence(releaseId)") < publisher.indexOf('rpc("publish_platform_configuration_release_atomic"'));
    assert.ok(admin.includes('.eq("configuration_hash", expectedHash)'));
    assert.ok(admin.includes("pendingCredentials.some(change => change.modelKey === `${entry.configuration.legacyTable}:${entry.configuration.legacyId}`)"));
    const ui = readFileSync(new URL("../src/components/unified-models-tab.tsx", import.meta.url), "utf8");
    assert.ok(ui.includes("visionActions[model.id]?.unknown")); assert.ok(ui.includes("textActionLocks.current.add(model.id)"));
    assert.ok(ui.includes('capability: "vision"')); assert.ok(ui.includes("结果待核对"));
  });
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, networkCalls, databaseCalls: 0, providerCalls: 0,
    evidenceLevel: "Zero-network fixtures and mocked route execution only; no real vision capability, credential, database, supplier charge or UI acceptance" }, null, 2));
} finally { globalThis.fetch = savedFetch; }
