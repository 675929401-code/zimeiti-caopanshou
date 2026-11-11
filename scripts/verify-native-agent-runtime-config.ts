import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { adminRequirementForRequest } from "../src/lib/admin-governance";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NativeAgentRuntimeConfigSchema } from "../src/lib/native-agent-runtime-contract";
import { toPublicModelId } from "../src/lib/public-model-dto";
import { nativeAgentRuntimeConfigHash, nativeAgentRuntimeModelChoices, NativeAgentRuntimeConfigError,
  readNativeAgentRuntimeConfig, resolveNativeAgentRuntimeSnapshot, saveNativeAgentRuntimeConfig } from "../src/lib/server/native-agent-runtime-config";

type Row = Record<string, unknown>;
const checks: string[] = [];
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const model = (id = "11111111-1111-4111-8111-111111111111", patch: Row = {}): Row => ({ id, name: "测试文本模型", model_name: "fixture-model", category: "text", is_active: true, is_hidden: false, user_access: "available",
  provider: "fixture-provider", api_protocol_config: { protocol: "anthropic_messages", auth_scheme: "x-api-key" }, api_endpoint: "https://models.invalid/v1",
  token_billing_enabled: true, input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0, profit_margin: 10, token_rounding_unit: 0, ...patch });
const id = toPublicModelId("chat", String(model().id));
const enabled = () => NativeAgentRuntimeConfigSchema.parse({ enabled: true, modelIds: { default: id, background: id, think: id }, allowedModelIds: [id] });
const stored = (config = enabled(), revision = 1): Row => ({ revision, config, config_hash: nativeAgentRuntimeConfigHash(config), updated_at: "2026-11-10T00:00:00.000Z" });

/** In-memory database boundary only. No credentials, SQL client or live configuration are loaded. */
function database(initial: Row | null = null, rows: Row[] = [model()]) {
  const state = { current: initial, rows, readError: null as unknown, rpcError: null as unknown, rpcCalls: [] as Row[], selects: [] as string[],
    readAfterSave: null as Row | null, returnTampered: false };
  const db = {
    from(table: string) {
      assert.ok(["pub_native_agent_runtime_config", "llm_models"].includes(table));
      return { select(fields: string) { state.selects.push(fields); assert.equal(/api_key|\*/u.test(fields), false, "secret fields must never be selected"); return this; },
        eq(column: string, value: unknown) { assert.equal(table, "pub_native_agent_runtime_config"); assert.equal(column, "singleton"); assert.equal(value, true); return this; },
        async maybeSingle() { return { data: state.current, error: state.readError }; },
        async order(column: string) { assert.equal(table, "llm_models"); assert.equal(column, "sort_order"); return { data: state.rows, error: null }; } };
    },
    async rpc(name: string, parameters: Row) {
      assert.equal(name, "mutate_native_agent_runtime_config"); state.rpcCalls.push(parameters);
      if (state.rpcError) return { data: null, error: state.rpcError };
      const saved = { revision: Number(parameters.p_expected_revision) + 1, config: parameters.p_config, config_hash: parameters.p_config_hash, updated_at: "2026-11-10T01:00:00.000Z" };
      state.current = state.readAfterSave ?? saved;
      return { data: state.returnTampered ? { ...saved, config_hash: "f".repeat(64) } : saved, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, state };
}
async function rejectsCode(promise: Promise<unknown>, code: string, status = 503) {
  await assert.rejects(promise, (error: unknown) => error instanceof NativeAgentRuntimeConfigError && error.code === code && error.status === status);
}
async function check(name: string, run: () => void | Promise<void>) { await run(); checks.push(name); }

async function main() {
  let networkCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw Error("Unexpected network access"); };
  try {
    await check("disabled defaults, decimal precision and hard budget boundaries", () => {
      const defaults = NativeAgentRuntimeConfigSchema.parse({});
      assert.equal(defaults.enabled, false); assert.deepEqual(defaults.modelIds, { default: null, background: null, think: null });
      assert.equal(defaults.maxCreditsPerTurn, "50.000000"); assert.equal(defaults.maxCallsPerTurn, 8);
      for (const patch of [{ maxCallsPerTurn: 0 }, { maxCallsPerTurn: 25 }, { maxCallsPerTurn: 1.2 }, { maxOutputTokens: 511 }, { maxOutputTokens: 8193 }, { maxInputBytes: 16383 }, { maxInputBytes: 1048577 },
        { maxCreditsPerTurn: "0" }, { maxCreditsPerTurn: "1.0000001" }, { maxCreditsPerTurn: "1e3" }, { apiKey: "forbidden" }, { allowedModelIds: [id, id] }]) assert.equal(NativeAgentRuntimeConfigSchema.safeParse(patch).success, false);
      assert.equal(NativeAgentRuntimeConfigSchema.parse({ maxCreditsPerTurn: "0.000001" }).maxCreditsPerTurn, "0.000001");
      assert.equal(NativeAgentRuntimeConfigSchema.safeParse({ enabled: true }).success, false);
      const ids = Array.from({ length: 17 }, (_, index) => `pm_${String(index).padStart(24, "0")}`);
      assert.equal(NativeAgentRuntimeConfigSchema.safeParse({ allowedModelIds: ids }).success, false);
    });
    await check("admin model choices retain incompatible, hidden and unpriced rows with reasons", () => {
      const choices = nativeAgentRuntimeModelChoices([model(), model("other", { api_protocol_config: { protocol: "openai_chat" } }), model("hidden", { is_hidden: true }), model("unpriced", { output_cost_per_million: null })]);
      assert.equal(choices.length, 4); assert.equal(choices[0].available, true);
      assert.ok(choices.slice(1).every(choice => !choice.available && choice.reasons.length));
      assert.equal(JSON.stringify(choices).includes("https://"), false);
    });
    await check("missing schema is explicit 503, while existing empty table is unconfigured and blocked", async () => {
      const missing = database(); missing.state.readError = { code: "PGRST205", message: "missing" };
      await rejectsCode(readNativeAgentRuntimeConfig(missing.db), "NATIVE_AGENT_RUNTIME_SCHEMA_REQUIRED");
      const empty = database(); const state = await readNativeAgentRuntimeConfig(empty.db);
      assert.equal(state.configured, false); assert.equal(state.revision, 0); assert.equal(state.readiness.ready, false);
      await rejectsCode(resolveNativeAgentRuntimeSnapshot(empty.db), "NATIVE_AGENT_RUNTIME_NOT_CONFIGURED");
      assert.equal(empty.state.rpcCalls.length, 0);
    });
    await check("disabled configuration never falls back to first global model", async () => {
      const fixture = database(stored(NativeAgentRuntimeConfigSchema.parse({})));
      await rejectsCode(resolveNativeAgentRuntimeSnapshot(fixture.db), "NATIVE_AGENT_RUNTIME_DISABLED"); assert.equal(fixture.state.rpcCalls.length, 0);
    });
    await check("request-time snapshot contains only configured public model roles and budgets", async () => {
      const fixture = database(stored()); const snapshot = await resolveNativeAgentRuntimeSnapshot(fixture.db);
      assert.deepEqual(snapshot.roles.default, { modelId: id, modelName: "fixture-model" }); assert.equal(snapshot.revision, 1);
      assert.deepEqual(Object.keys(snapshot).sort(), ["revision", "configHash", "roles", "maxCallsPerTurn", "maxOutputTokens", "maxInputBytes", "maxCreditsPerTurn"].sort());
      assert.equal(JSON.stringify(snapshot).includes(String(model().id)), false); assert.equal(JSON.stringify(snapshot).includes("https://"), false);
    });
    await check("changed model price, protocol and missing selection fail before runtime", async () => {
      for (const rows of [[model("other")], [model(undefined, { output_cost_per_million: null })], [model(undefined, { api_protocol_config: { protocol: "openai_chat" } })]])
        await rejectsCode(resolveNativeAgentRuntimeSnapshot(database(stored(), rows).db), "NATIVE_AGENT_RUNTIME_MODEL_UNAVAILABLE");
      const tampered = database({ ...stored(), config_hash: "0".repeat(64) }); await rejectsCode(readNativeAgentRuntimeConfig(tampered.db), "NATIVE_AGENT_RUNTIME_CONFIG_INVALID");
    });
    await check("disabled candidate saves through CAS RPC and independent readback without activation", async () => {
      const fixture = database(); const config = NativeAgentRuntimeConfigSchema.parse({});
      const result = await saveNativeAgentRuntimeConfig(fixture.db, actor, { expectedRevision: 0, config });
      assert.equal(result.revision, 1); assert.equal(result.configured, true); assert.equal(result.readiness.ready, false);
      assert.equal(fixture.state.rpcCalls.length, 1); assert.equal(fixture.state.rpcCalls[0].p_actor, actor); assert.equal(fixture.state.rpcCalls[0].p_expected_revision, 0);
    });
    await check("stale revision, RPC race and readback race cannot overwrite silently", async () => {
      const stale = database(stored()); await rejectsCode(saveNativeAgentRuntimeConfig(stale.db, actor, { expectedRevision: 0, config: enabled() }), "NATIVE_AGENT_RUNTIME_REVISION_CONFLICT", 409); assert.equal(stale.state.rpcCalls.length, 0);
      const raced = database(stored()); raced.state.rpcError = { code: "P0001", message: "NATIVE_AGENT_RUNTIME_REVISION_CONFLICT" };
      await rejectsCode(saveNativeAgentRuntimeConfig(raced.db, actor, { expectedRevision: 1, config: enabled() }), "NATIVE_AGENT_RUNTIME_REVISION_CONFLICT", 409);
      const readback = database(stored()); readback.state.readAfterSave = stored(enabled(), 3);
      await rejectsCode(saveNativeAgentRuntimeConfig(readback.db, actor, { expectedRevision: 1, config: enabled() }), "NATIVE_AGENT_RUNTIME_READBACK_CONFLICT", 409);
    });
    await check("enabled save revalidates selected pool models and refuses protocol mismatch before mutation", async () => {
      const fixture = database(null, [model(undefined, { api_protocol_config: { protocol: "openai_chat" } })]);
      await rejectsCode(saveNativeAgentRuntimeConfig(fixture.db, actor, { expectedRevision: 0, config: enabled() }), "NATIVE_AGENT_RUNTIME_MODEL_UNAVAILABLE", 422); assert.equal(fixture.state.rpcCalls.length, 0);
    });
    await check("proxy policy maps only exact runtime GET and POST and preserves the unknown-route guard", () => {
      assert.deepEqual(adminRequirementForRequest("/api/admin/native-agent-runtime", "GET"), { permission: "models.view", requireStepUp: false, operation: "native_agent_runtime_read" });
      assert.deepEqual(adminRequirementForRequest("/api/admin/native-agent-runtime", "POST"), { permission: "models.manage", requireStepUp: true, operation: "native_agent_runtime_save" });
      for (const [pathname, method] of [["/api/admin/native-agent-runtime/unregistered", "GET"], ["/api/admin/native-agent-runtime", "DELETE"]]) {
        assert.deepEqual(adminRequirementForRequest(pathname, method), { permission: "admin.accounts.manage", requireStepUp: true, operation: "unmapped_admin_api" });
      }
    });
    await check("actual API handlers enforce model permissions and POST step-up before storage", async () => {
      // Execute the actual route with only authority and database boundaries replaced.
      const fixture = database(); const authCalls: { permission: string; options: Row }[] = []; let allowed = false, dbAccess = 0;
      const routeModule = { exports: {} as { GET: (request: NextRequest) => Promise<Response>; POST: (request: NextRequest) => Promise<Response> } };
      const source = readFileSync(new URL("../src/app/api/admin/native-agent-runtime/route.ts", import.meta.url), "utf8");
      const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
      runInNewContext(compiled, { module: routeModule, exports: routeModule.exports, TextEncoder, require: (specifier: string) => {
        if (specifier === "next/server") return { NextResponse };
        if (specifier.endsWith("admin-governance-authority")) return { authorizeAdminCapability: async (_request: unknown, permission: string, options: Row) => {
          authCalls.push({ permission, options }); return allowed ? { ok: true, actor: { userId: actor } } : { ok: false, response: NextResponse.json({ error: "denied" }, { status: 403 }) };
        } };
        if (specifier.endsWith("supabase-client")) return { getSupabaseAdminClient: () => { dbAccess++; return fixture.db; } };
        if (specifier.endsWith("native-agent-runtime-config")) return { NativeAgentRuntimeConfigError, readNativeAgentRuntimeConfig, saveNativeAgentRuntimeConfig };
        throw Error(`Unexpected route import: ${specifier}`);
      } });
      const request = () => new NextRequest("http://127.0.0.1:5000/api/admin/native-agent-runtime");
      assert.equal((await routeModule.exports.GET(request())).status, 403); assert.equal(authCalls[0].permission, "models.view"); assert.equal(authCalls[0].options.requireStepUp, false); assert.equal(dbAccess, 0);
      assert.equal((await routeModule.exports.POST(request())).status, 403); assert.equal(authCalls[1].permission, "models.manage"); assert.equal(authCalls[1].options.requireStepUp, true); assert.equal(dbAccess, 0);
      allowed = true; const get = await routeModule.exports.GET(request()); assert.equal(get.status, 200); assert.equal((await get.json()).configured, false);
      const invalid = await routeModule.exports.POST(new NextRequest(request(), { method: "POST", body: "{" })); assert.equal(invalid.status, 400);
      const large = await routeModule.exports.POST(new NextRequest(request(), { method: "POST", body: " ".repeat(16385) })); assert.equal(large.status, 413);
      const save = await routeModule.exports.POST(new NextRequest(request(), { method: "POST", body: JSON.stringify({ expectedRevision: 0, config: NativeAgentRuntimeConfigSchema.parse({}) }) }));
      assert.equal(save.status, 200); assert.equal((await save.json()).revision, 1); assert.equal(fixture.state.rpcCalls.length, 1);
      const conflict = await routeModule.exports.POST(new NextRequest(request(), { method: "POST", body: JSON.stringify({ expectedRevision: 0, config: enabled() }) })); assert.equal(conflict.status, 409);
    });
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ ok: true, scope: "in-memory boundary contracts; no live database, provider, browser or billing acceptance", checks, networkCalls, liveDatabaseCalls: 0 }, null, 2));
  } finally { globalThis.fetch = previousFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
