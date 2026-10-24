import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as validation from "../src/lib/llm-model-validation-gate";
import * as endpoint from "../src/lib/model-endpoint";
import * as protocol from "../src/lib/llm-provider-contract";

// Execute the real route body against an in-memory DB and supplier boundary.
// No runtime env discovery, credentials, database or provider connection.
class ConfigurationError extends Error { code = "MODEL_NOT_IN_CURRENT_POOL"; }
const baseModel = {
  id: "fixture", model_name: "claude-opus-5-5", api_endpoint: "https://n.lconai.com/v1", api_key: "synthetic-fixture-key", max_reply_tokens: 4096, deep_thinking_type: 0, timeout: 45,
  api_protocol_config: { provider: "lconai", protocol: "anthropic_messages", auth_scheme: "bearer", thinking_strategy: "provider_default" },
  updated_at: "2026-10-15T00:00:00Z",
};
let model: Record<string, unknown> = structuredClone(baseModel);
let published = true;
let allowed = true;
let mutateDuringProbe = false;
let instructionPass = true;
let mockDispatches = 0;
let evidenceWrites = 0;
let lastConfiguration: Record<string, unknown> = {};
const db = { from(table: string) {
  const query = {
    select() { return query; }, eq() { return query; },
    upsert(value: Record<string, unknown>) { evidenceWrites++; assert.equal(table, "llm_model_validation_evidence"); assert.equal(value.configuration_hash, validation.llmModelValidationConfigurationHash(model, String(model.api_key))); return query; },
    async maybeSingle() { return { data: table === "agents" ? { model_id: model.id } : structuredClone(model), error: null }; },
    async single() { return { data: { id: "evidence-fixture", checked_at: new Date().toISOString() }, error: null }; },
  };
  return query;
} };
const modules: Record<string, unknown> = {
  "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
  "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/lib/server/admin-governance-authority": { authorizeAdminCapability: async (_req: unknown, capability: string, options: { requireStepUp: boolean }) => { assert.equal(capability, "models.manage"); assert.equal(options.requireStepUp, true); return allowed ? { ok: true, actor: { userId: "fixture-admin" } } : { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) }; } },
  "@/lib/model-endpoint": endpoint,
  "@/lib/provider-secret": { resolveProviderSecret: (key: string) => key },
  "@/lib/safe-fetch": { validateSafeUrl: async () => undefined },
  "@/lib/llm-model-validation-gate": validation,
  "@/lib/llm-provider-contract": protocol,
  "@/lib/model-probe-result": { modelProbeFailure: () => ({ diagnosticCode: "MOCK_FAILED", message: "fixture" }) },
  "@/lib/server/platform-configuration-compatibility": { assertPublishedModelPoolEntry: async () => { if (!published) throw new ConfigurationError("未发布"); } },
  "@/lib/server/platform-configuration-admin": { PlatformConfigurationError: ConfigurationError },
  "@/lib/llm-proxy/proxy": { LLMProxy: class {
    constructor(config: Record<string, unknown>) { lastConfiguration = config; }
    async chat(request: { model: string; messages: Array<{ content: string }> }) {
      mockDispatches++;
      if (mutateDuringProbe) model = { ...model, max_reply_tokens: 8192 };
      const expected = /Return exactly (\S+) and/u.exec(request.messages[0].content)![1];
      return { content: instructionPass ? expected : "wrong", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }
  } },
};
const exportsObject: { POST?: (request: unknown) => Promise<Response> } = {};
const compiled = ts.transpileModule(fs.readFileSync("src/app/api/admin/llm-test/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(compiled, {
  exports: exportsObject,
  require(name: string) { if (!(name in modules)) throw new Error("Unexpected route dependency: " + name); return modules[name]; },
  Response, URL, crypto: globalThis.crypto, Date, console,
}, { filename: "llm-test-real-route.fixture.cjs" });

let cases = 0;
async function run(body: Record<string, unknown>, config: { published?: boolean; allowed?: boolean; mutate?: boolean; pass?: boolean } = {}) {
  cases++;
  model = structuredClone(baseModel); published = config.published !== false; allowed = config.allowed !== false;
  mutateDuringProbe = config.mutate === true; instructionPass = config.pass !== false; mockDispatches = 0; evidenceWrites = 0;
  const response = await exportsObject.POST!({ json: async () => body });
  return { status: response.status, body: await response.json() };
}
async function main() {
  let result = await run({ scope: "saved", model_id: "fixture" });
  assert.equal(result.body.success, true); assert.equal(result.body.scope, "saved"); assert.equal(result.body.evidence.evidenceRecorded, true); assert.equal(evidenceWrites, 1); assert.equal(lastConfiguration.thinkingStrategy, "provider_default");
  result = await run({ scope: "draft", model_id: "fixture", model_name: "new-id" });
  assert.equal(result.body.success, true); assert.equal(result.body.scope, "draft"); assert.equal(result.body.evidence, null); assert.equal(evidenceWrites, 0); assert.equal(lastConfiguration.defaultModel, "new-id");
  result = await run({ model_id: "fixture", model_name: "legacy-draft" });
  assert.equal(result.body.scope, "draft"); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "saved", model_id: "fixture", api_endpoint: baseModel.api_endpoint });
  assert.equal(result.status, 400); assert.equal(mockDispatches, 0); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "draft", model_id: "fixture", api_endpoint: "https://different.invalid/v1" });
  assert.equal(result.body.success, false); assert.equal(result.body.paidProbeUsed, false); assert.equal(mockDispatches, 0); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "saved", model_id: "fixture" }, { published: false });
  assert.equal(result.status, 409); assert.equal(mockDispatches, 0); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "saved", model_id: "fixture" }, { mutate: true });
  assert.equal(result.status, 409); assert.equal(result.body.diagnosticCode, "VALIDATION_CONFIGURATION_CHANGED"); assert.equal(mockDispatches, 1); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "saved", model_id: "fixture" }, { pass: false });
  assert.equal(result.body.success, false); assert.equal(evidenceWrites, 0);
  result = await run({ scope: "saved", agent_id: "agent-fixture" });
  assert.equal(result.body.success, true); assert.equal(evidenceWrites, 1);
  result = await run({ scope: "saved", model_id: "fixture" }, { allowed: false });
  assert.equal(result.status, 403); assert.equal(mockDispatches, 0); assert.equal(evidenceWrites, 0);
  console.log(JSON.stringify({ passed: true, cases, executedRouteBody: true, mockedProviderAndDatabase: true, externalProviderCalls: 0, actualDatabaseWrites: 0, realBillingAcceptance: false }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
