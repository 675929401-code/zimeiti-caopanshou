import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { z } from "zod";
import * as contracts from "../src/lib/native-agent-contract";
import * as stream from "../src/lib/native-agent-stream";
import * as aiContracts from "../src/lib/native-ai-contract";
import * as operationContracts from "../src/lib/native-operations-contract";
import * as draftContracts from "../src/lib/publishing-v2-contract";
import * as protocol from "../src/lib/native-agent-model-protocol";
import * as runtimeConfig from "../src/lib/server/native-agent-runtime-config";
import * as publicModels from "../src/lib/public-model-dto";
import * as providerBinding from "../src/lib/llm-provider-contract";
import * as eligibility from "../src/lib/text-model-eligibility";
import * as pricing from "../src/lib/text-model-pricing";
import { routeConfigurationTables } from "../src/storage/database/configuration-source";
import { NativeAgentRuntimeConfigSchema, type NativeAgentRuntimeConfigSnapshot } from "../src/lib/native-agent-runtime-contract";
import { PublishingError } from "../src/lib/server/publishing-service";
import type { AuthUser } from "../src/lib/api-middleware";
import type { LlmRequestAttemptExecution, LlmRequestAttemptRecord, LlmRequestAttemptStore } from "../src/lib/llm-request-idempotency";
import type { NativeAgentSdkRuntimePorts, NativeAgentSdkTurnInput, NativeAgentSdkTurnResult } from "../src/lib/server/native-agent-runtime/types";
import type * as AgentService from "../src/lib/server/native-agent-service";
import type * as SdkService from "../src/lib/server/native-agent-sdk-service";

type Row = Record<string, unknown>;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherOwner = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", turnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const draftId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", runnerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const sessionId = "12121212-1212-4121-8121-121212121212", checkpoint = "b".repeat(64);
const modelInternalId = "11111111-1111-4111-8111-111111111111", modelId = publicModels.toPublicModelId("chat", modelInternalId);
const user = { id: owner, role: "user" } as AuthUser;
const cookies = { get: () => undefined };
const origin = "http://127.0.0.1:5000";
const root = process.cwd();
const clone = <T>(value: T): T => structuredClone(value);
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const hash = (value: string | Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
const config = NativeAgentRuntimeConfigSchema.parse({ enabled: true, modelIds: { default: modelId, background: modelId, think: modelId }, allowedModelIds: [modelId] });
const configHash = runtimeConfig.nativeAgentRuntimeConfigHash(config);
const snapshot: NativeAgentRuntimeConfigSnapshot = { revision: 3, configHash, roles: { default: { modelId, modelName: "claude-fixture" }, background: { modelId, modelName: "claude-fixture" }, think: { modelId, modelName: "claude-fixture" } },
  maxCallsPerTurn: 8, maxInputBytes: 262144, maxOutputTokens: 4096, maxCreditsPerTurn: "50.000000" };
const startInput = (patch: Row = {}) => ({ requestKey: "native-sdk-integration-request", prompt: "读取并改写我的草稿", runtimeApproval: { revision: snapshot.revision, configHash, maxCreditsPerTurn: "50.000000" }, ...patch });
const frozenRequest = (input = startInput()) => {
  const parsed = contracts.NativeAgentMemberStartSchema.parse(input);
  return { taskId: parsed.taskId ?? null, expectedRevision: parsed.expectedRevision ?? null, prompt: parsed.prompt, context: parsed.context, runtimeApproval: parsed.runtimeApproval };
};
const task = () => ({ id: taskId, owner_id: owner, title: "自有任务", status: "completed", revision: 4, next_seq: 0, archived: false });
const turn = (patch: Row = {}): Row => ({ id: turnId, owner_id: owner, task_id: taskId, request_key: startInput().requestKey, state: "running", revision: 2,
  input_snapshot: frozenRequest(), policy_snapshot: { version: "native-agent-sdk.v1", config: clone(snapshot) }, lease_owner: runnerId, lease_expires_at: "2099-01-01T00:00:00.000Z", ...patch });
const complete = (): NativeAgentSdkTurnResult => ({ state: "completed", sessionId, checkpointHash: checkpoint, responseText: "完成", modelCalls: 0, toolCalls: 0 });
const modelRow = () => ({ id: modelInternalId, name: "测试模型", model_name: "claude-fixture", category: "text", is_active: true, is_hidden: false, user_access: "available", sort_order: 1,
  provider: "offline-fixture", api_protocol_config: { protocol: "anthropic_messages", auth_scheme: "x-api-key" }, api_endpoint: "https://models.invalid/v1", api_key: "offline-placeholder",
  token_billing_enabled: true, input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0, profit_margin: 10, token_rounding_unit: 0 });
const safety = () => ({ policy: "native-agent-unknown-hold.v1", databaseVerified: true, preservesUnknownHolds: true, preservesExpiredProviderHolds: true, policyFingerprint: "c".repeat(64) });

/** Executes unmodified production modules. Same-realm VM compilation preserves canonical object identity. */
function productionModule(relative: string, dependencies: Row): Row {
  const filename = path.resolve(root, relative), fixtureModule = { exports: {} as Row };
  const source = readFileSync(filename, "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const requireBoundary = (specifier: string) => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
    throw Error(`UNMAPPED_PRODUCTION_DEPENDENCY ${relative}: ${specifier}`);
  };
  compileFunction(compiled, ["module", "exports", "require", "fetch"], { filename })(fixtureModule, fixtureModule.exports, requireBoundary,
    dependencies.__fetch ?? (() => { throw Error("UNEXPECTED_TRANSPORT"); }));
  return fixtureModule.exports;
}

function fixture() {
  const state = {
    tasks: [task()] as Row[], turns: [] as Row[], events: [] as Row[], sessions: [] as Row[], models: [modelRow()] as Row[],
    businessShadowModels: [{ ...modelRow(), api_protocol_config: { protocol: "openai_chat" }, model_name: "stale-business-model" }] as Row[],
    configRows: [{ revision: 3, config, config_hash: configHash, updated_at: "2026-11-10T00:00:00Z" }] as Row[],
    configError: null as unknown, safetyError: null as unknown, safetyData: safety() as Row, atomicError: null as unknown, prepareError: null as unknown,
    runtimeCalls: [] as NativeAgentSdkTurnInput[], rpcCalls: [] as { name: string; parameters: Row }[], queries: [] as { table: string; fields: string; filters: [string, unknown][]; source: "configuration" | "business" }[],
    operations: [] as { owner: string; method: string; path: string[] }[], order: [] as string[], calls: new Map<string, Row>(), attemptRecords: new Map<string, LlmRequestAttemptRecord>(),
    reserves: 0, releases: 0, settlements: 0, providerEntries: 0, secrets: 0, refuseNativeAccess: false, resourceFailure: false, transportUnknown: false, reserveDenied: false,
    versionRows: [] as Row[], metadataRows: [] as Row[], coreResult: { base: { row: { id: draftId, revision: 1 } }, metadataRevision: 1 } as Row,
    script: (async () => complete()) as (input: NativeAgentSdkTurnInput, ports: NativeAgentSdkRuntimePorts) => Promise<NativeAgentSdkTurnResult>,
  };
  const tables = (name: string): Row[] => {
    const values: Record<string, Row[]> = { pub_native_agent_tasks: state.tasks, pub_native_agent_turns: state.turns, pub_native_agent_events: state.events,
      pub_native_agent_runtime_sessions: state.sessions, llm_models: state.models, pub_native_agent_runtime_config: state.configRows,
      pub2_draft_versions: state.versionRows, pub_native_draft_meta: state.metadataRows };
    assert.ok(Object.hasOwn(values, name), `Unexpected database table ${name}`); return values[name];
  };
  let configurationRead = false;
  const db = {
    from(table: string) {
      assert.ok(table !== "llm_models" || configurationRead, "model resources must use the unified configuration client");
      const query = { table, fields: "*", filters: [] as [string, unknown][], max: Infinity, source: configurationRead ? "configuration" as const : "business" as const };
      state.queries.push(query);
      const result = (single = false) => {
        if (table === "pub_native_agent_runtime_config" && state.configError) return { data: null, error: state.configError };
        let data = tables(table).filter(item => query.filters.every(([column, value]) => item[column] === value || table === "pub_native_agent_runtime_config" && column === "singleton" && value === true)).slice(0, query.max);
        if (query.fields !== "*") data = data.map(item => Object.fromEntries(query.fields.split(",").map(key => [key, item[key]])));
        return { data: single ? data[0] ?? null : data, error: null, count: data.length };
      };
      const builder = { select(fields: string) { query.fields = fields; return this; }, eq(column: string, value: unknown) { query.filters.push([column, value]); return this; },
        gt() { return this; }, order() { return this; }, limit(value: number) { query.max = value; return this; },
        async maybeSingle() { return result(true); }, then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject); } };
      return builder;
    },
    async rpc(name: string, parameters: Row = {}) {
      state.rpcCalls.push({ name, parameters: clone(parameters) });
      if (name === "native_agent_reservation_safety") { state.order.push("safety-readback"); return { data: state.safetyData, error: state.safetyError }; }
      if (name === "mutate_native_core_atomic") { state.order.push("core-save"); return { data: clone(state.coreResult), error: null }; }
      if (name === "reconcile_native_agent_main_atomic") throw Error("SDK turn reached legacy main reconciliation");
      assert.ok(["mutate_native_agent_sdk", "mutate_native_agent_atomic"].includes(name));
      assert.equal(parameters.p_owner, owner, "every mutation must carry authenticated owner");
      const input = row(parameters.p), action = String(input.action); state.order.push(`sql:${action}`);
      if (name === "mutate_native_agent_atomic") {
        if (state.atomicError) return { data: null, error: state.atomicError };
        const selected = state.turns.find(item => item.id === input.turnId);
        if (action === "claim-turn") {
          const shouldExecute = selected?.state === "prepared";
          if (shouldExecute && selected) { selected.state = "running"; selected.lease_owner = input.runnerId; }
          return { data: { shouldExecute, turn: clone(selected ?? {}) }, error: null };
        }
        assert.equal(action, "observe-unknown"); if (selected) selected.state = "unknown";
        return { data: {}, error: null };
      }
      if (action === "prepare") {
        if (state.prepareError) return { data: null, error: state.prepareError };
        const prepared = turn({ id: input.turnId, state: "prepared", input_snapshot: clone(input.request), policy_snapshot: { version: "native-agent-sdk.v1", config: clone(input.config) }, request_key: input.requestKey });
        state.turns.push(prepared); return { data: { task: task(), turn: clone(prepared) }, error: null };
      }
      const selected = state.turns.find(item => item.id === input.turnId);
      assert.ok(selected, "SDK mutation references an owned persisted turn");
      assert.equal(selected.owner_id, owner); assert.equal(input.runnerId, selected.lease_owner, "runner CAS must be retained");
      if (action === "begin-call") {
        const prior = state.calls.get(String(input.callId));
        if (prior) return prior.state === "succeeded" ? { data: { replayed: true, call: clone(prior) }, error: null }
          : { data: null, error: { message: "NATIVE_AGENT_ACTIVE_TURN" } };
        if (selected.state === "unknown" || [...state.calls.values()].some(item => item.state === "unknown")) return { data: null, error: { message: "NATIVE_AGENT_ACTIVE_TURN" } };
        state.calls.set(String(input.callId), { state: "started", kind: input.kind, inputHash: input.inputHash });
        return { data: { replayed: false }, error: null };
      }
      if (action === "reserve-call") {
        if (state.reserveDenied) return { data: null, error: { message: "NATIVE_AGENT_BUDGET_EXCEEDED" } };
        const call = state.calls.get(String(input.callId)); assert.ok(call); call.reserved_credits = input.amount;
      } else if (action === "finish-call") {
        const call = state.calls.get(String(input.callId)); assert.ok(call); call.state = "succeeded"; call.result = clone(input.result); call.charged_credits = input.chargedCredits;
      } else if (action === "freeze") {
        selected.state = "unknown"; for (const call of state.calls.values()) if (call.state === "started") call.state = "unknown";
      } else if (action === "save-session") {
        state.sessions = [{ owner_id: owner, task_id: selected.task_id, turn_id: selected.id, session_id: input.sessionId, checkpoint_hash: input.checkpointHash }];
      } else if (action === "finish") selected.state = input.state;
      else assert.equal(action, "event");
      return { data: {}, error: null };
    },
  } as unknown as Parameters<typeof AgentService.startNativeAgentSdkTurn>[1];
  const attempts: LlmRequestAttemptStore = {
    async claim(input) {
      state.order.push("attempt-claim");
      const key = input.userId + ":" + input.clientRequestId, previous = state.attemptRecords.get(key);
      if (previous) return { action: previous.state === "succeeded" ? "replay" : "reconciliation_required", record: clone(previous) };
      const record: LlmRequestAttemptRecord = { recordId: hash(input.userId + "\0" + input.clientRequestId), userId: input.userId, clientRequestId: input.clientRequestId,
        payloadFingerprint: input.payloadFingerprint, state: "running", attemptNo: 1, leaseOwner: input.leaseOwner, leaseToken: 1, leaseExpiresAt: "2099-01-01T00:00:00Z", providerCallStartedAt: null,
        httpStatus: null, responseHeaders: {}, responseBody: null, responseFingerprint: null, resultReference: null, errorCode: null, errorMessage: null, createdAt: "now", updatedAt: "now" };
      state.attemptRecords.set(key, clone(record)); return { action: "execute", execution: { record, leaseOwner: input.leaseOwner, leaseToken: 1 } };
    },
    async markProviderCallStarted(execution) { state.order.push("provider-mark"); return { ...execution, record: { ...execution.record, providerCallStartedAt: "2026-11-10T00:00:00Z" } }; },
    async finalize(input) {
      state.order.push("attempt-finalize:" + input.state);
      const saved = { ...input.execution.record, state: input.state, httpStatus: input.httpStatus ?? null, responseBody: input.responseBody ?? null,
        responseHeaders: input.responseHeaders ?? {}, responseFingerprint: input.responseFingerprint ?? null, resultReference: input.resultReference ?? null, errorCode: input.errorCode ?? null, errorMessage: input.errorMessage ?? null };
      state.attemptRecords.set(saved.userId + ":" + saved.clientRequestId, clone(saved)); return saved;
    },
  };
  const selectedPricing = { publicModelId: modelId, internalModelId: modelInternalId, modelName: "claude-fixture", config: { inputCostPerMillion: 1, outputCostPerMillion: 2,
    cachedCostPerMillion: 0, profitMargin: 10, creditsPerYuan: 50, tokenRoundingEnabled: false, tokenRoundingUnit: 0, tokenRoundingMin: 100, tokenRoundingMax: 10000 },
    priceSnapshot: { source: "offline-fixture-selected-model", revision: 3 } };
  const billing = { calculateCredits: () => ({ creditsCharged: 2 }) };
  const wallet = {
    validateLlmStreamReservationSettlement: () => undefined,
    async reserveLlmStreamCredits(execution: LlmRequestAttemptExecution, amount: number) { state.reserves++; state.order.push("wallet-reserve"); return { recordId: execution.record.recordId, leaseOwner: execution.leaseOwner, leaseToken: execution.leaseToken, amount }; },
    async releaseLlmStreamCredits() { state.releases++; state.order.push("wallet-release"); },
  };
  const llmBilling = { async getSelectedModelBillingSnapshot(id: string) { assert.equal(id, modelId); return clone(selectedPricing); },
    async settleLlmUsage(actorId: string) { assert.equal(actorId, owner); state.settlements++; state.order.push("wallet-settle"); return { success: true, operationId: "offline-operation-1", billing: { creditsCharged: 0.25 } }; } };
  const nativeOperations = {
    async assertNativeAccess(actor: AuthUser) { assert.equal(actor.id, owner); if (state.refuseNativeAccess) throw new PublishingError("PUBLISH_CENTER_FORBIDDEN", "access denied", 403); },
    async executeNativeOperation(actor: AuthUser, _db: unknown, method: string, url: string[]) {
      state.operations.push({ owner: actor.id, method, path: url }); assert.equal(actor.id, owner); assert.equal(method, "GET");
      if (state.resourceFailure) throw new PublishingError("NATIVE_RESOURCE_NOT_FOUND", "owned resource absent", 404);
      return { data: { id: url.at(-1), title: "原标题", desc: "原正文", nativeRevision: 2, nativeMetadataRevision: 1, groupId: null, medias: [{ url: "https://signed.invalid/secret" }], privateProvider: "must-be-removed" } };
    },
  };
  const gateway = productionModule("src/lib/server/native-agent-model-gateway.ts", { "server-only": {}, "node:crypto": crypto, "../native-agent-model-protocol": protocol,
    "../billing": billing, "../llm-credit-reservation": wallet, "../llm-billing": llmBilling, "../llm-request-idempotency": { DatabaseLlmRequestAttemptStore: function () { return attempts; } } });
  const sharedModelDb = { ...db, from(table: string) { assert.equal(table, "llm_models"); configurationRead = true; try { return db.from(table); } finally { configurationRead = false; } } };
  const configurationDb = routeConfigurationTables<object>(db, sharedModelDb);
  const configurationStorage = { getSupabaseAdminClient: () => configurationDb };
  const sdk = productionModule("src/lib/server/native-agent-sdk-service.ts", {
    "@/storage/database/supabase-client": configurationStorage,
    "server-only": {}, "node:crypto": crypto, "node:path": path, "@/lib/native-agent-contract": contracts, "@/lib/llm-billing": llmBilling,
    "@/lib/public-model-dto": publicModels, "@/lib/llm-provider-contract": providerBinding, "@/lib/text-model-eligibility": eligibility, "@/lib/text-model-pricing": pricing,
    "@/lib/provider-secret": { resolveProviderSecret: () => { state.secrets++; return "in-memory-transport-placeholder"; } }, "@/lib/runtime-paths": { resolveAppRuntimeDir: () => path.resolve(root, "../../../runtime-boundary-only") },
    "@/lib/native-operations-contract": operationContracts, "@/lib/publishing-v2-contract": draftContracts, "./native-operations-service": nativeOperations,
    "./publishing-provider-config": { readPublishingProviderConfiguration: () => ({ namespace: "offline-owned-connection" }) }, "./publishing-service": { PublishingError },
    "./native-agent-model-gateway": gateway, "./native-agent-runtime": { async runNativeAgentSdkTurn(input: NativeAgentSdkTurnInput, ports: NativeAgentSdkRuntimePorts) { state.runtimeCalls.push(clone(input)); return state.script(input, ports); } },
    __fetch: async (_url: URL, options: RequestInit) => {
      state.providerEntries++; state.order.push("transport-primitive"); assert.equal(options.redirect, "error");
      if (state.transportUnknown) throw Error("offline transport terminal unknown");
      const request = JSON.parse(String(options.body)); assert.equal(request.model, "claude-fixture");
      return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "已改写" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    },
  }) as unknown as typeof SdkService;
  const service = productionModule("src/lib/server/native-agent-service.ts", { "server-only": {}, "node:crypto": crypto, zod: { z }, "@/lib/native-agent-contract": contracts,
    "@/storage/database/supabase-client": configurationStorage,
    "@/lib/native-agent-stream": stream, "@/lib/native-ai-contract": aiContracts, "./native-operations-service": nativeOperations, "./publishing-service": { PublishingError },
    "./native-agent-runtime-config": runtimeConfig, "./native-agent-sdk-service": sdk }) as unknown as typeof AgentService;
  const options: AgentService.NativeAgentServiceOptions = { streamDurationMs: 0, planningRead: async () => ({ nativeActions: [], nativePlanningTurns: [] }) };
  const start = (input: Row = startInput()) => service.startNativeAgentSdkTurn(user, db, input, origin, cookies, options);
  const runtime = () => service.executeNativeAgentOperation(user, db, "GET", ["agent", "runtime"], new URLSearchParams(), null, origin, cookies, options);
  const run = (value: Row = state.turns[0]) => sdk.runOwnedNativeAgentSdk(user, db, value, String(value.lease_owner), origin, cookies);
  return { state, db, sdk, service, options, start, runtime, run };
}

function modelCall(input: NativeAgentSdkTurnInput, callId = "model:1") {
  return { ownerId: input.ownerId, taskId: input.taskId, turnId: input.turnId, configSnapshot: input.configSnapshot, callId, role: "default" as const,
    requestBody: { model: "claude-fixture", max_tokens: 512, stream: false, messages: [{ role: "user", content: "改写文字" }] }, signal: new AbortController().signal };
}
function toolContext(input: NativeAgentSdkTurnInput, invocationId = "tool:1") { return { ownerId: input.ownerId, taskId: input.taskId, turnId: input.turnId, invocationId, signal: new AbortController().signal }; }
const saveArgs = (patch: Row = {}) => ({ expectedRevision: 0, expectedMetadataRevision: 0, collectionId: null, contentType: "image" as const, title: "新稿", body: "改写正文", topics: [], assetIds: [], platforms: [], ...patch });
async function rejects(action: () => Promise<unknown>, code: string, status: number) {
  await assert.rejects(action, error => error instanceof PublishingError && error.code === code && error.status === status);
}
function configReads(f: ReturnType<typeof fixture>) { return f.state.queries.filter(query => query.table === "pub_native_agent_runtime_config").length; }
function mutations(f: ReturnType<typeof fixture>, action: string) { return f.state.rpcCalls.filter(call => row(call.parameters.p).action === action); }

async function main() {
  const checks: string[] = []; let realNetwork = 0;
  const priorFetch = globalThis.fetch; globalThis.fetch = async () => { realNetwork++; throw Error("REAL_NETWORK_FORBIDDEN"); };
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); checks.push(name); };
  try {
    await check("actual configuration router sends provider models to shared authority and runtime settings and owned records to business storage", async () => {
      const f = fixture(); assert.equal(row((await f.runtime()).data).ready, true);
      assert.equal(f.state.businessShadowModels[0].id, f.state.models[0].id); assert.notEqual(f.state.businessShadowModels[0].model_name, f.state.models[0].model_name);
      f.state.turns.push(turn()); f.state.script = async (input, ports) => { await ports.modelCall(modelCall(input)); return complete(); }; await f.run();
      assert.ok(f.state.queries.some(query => query.table === "llm_models") && f.state.queries.some(query => query.table === "pub_native_agent_runtime_config"));
      assert.ok(f.state.queries.filter(query => query.table === "llm_models").every(query => query.source === "configuration"));
      assert.ok(f.state.queries.filter(query => query.table !== "llm_models").every(query => query.source === "business"));
    });
    await check("missing disabled or incompatible shared model never falls back to a same-id business record", async () => {
      for (const models of [[], [{ ...modelRow(), is_active: false }], [{ ...modelRow(), api_protocol_config: { protocol: "openai_chat" } }]]) {
        const f = fixture(); f.state.models = models;
        assert.equal(row((await f.runtime()).data).ready, false);
        f.state.turns.push(turn()); f.state.script = async (input, ports) => { await ports.modelCall(modelCall(input)); return complete(); }; await f.run();
        assert.equal(f.state.providerEntries, 0); assert.equal(f.state.reserves, 0); assert.equal(f.state.settlements, 0); assert.equal(f.state.secrets, 0);
        assert.ok(f.state.queries.filter(query => query.table === "llm_models").every(query => query.source === "configuration"));
        assert.ok(mutations(f, "freeze").length > 0);
      }
    });
    await check("actual member start rejects modelId, mode and caller budgets before configuration or prepare", async () => {
      for (const extra of [{ modelId }, { mode: "plan" }, { maxCredits: "999" }, { runtime: "external" }]) {
        const f = fixture(); await rejects(() => f.start(startInput(extra)), "NATIVE_AGENT_INPUT_INVALID", 400);
        assert.equal(configReads(f), 0); assert.equal(f.state.rpcCalls.length, 0);
      }
    });
    await check("approval revision/hash/budget races return 409 before context or prepare", async () => {
      for (const extra of [{ revision: 4 }, { configHash: "d".repeat(64) }, { maxCreditsPerTurn: "51.000000" }]) {
        const f = fixture(); await rejects(() => f.start(startInput({ runtimeApproval: { ...startInput().runtimeApproval, ...extra } })), "NATIVE_AGENT_RUNTIME_APPROVAL_CHANGED", 409);
        assert.equal(mutations(f, "prepare").length, 0); assert.equal(f.state.operations.length, 0); assert.equal(f.state.runtimeCalls.length, 0);
      }
    });
    await check("context reads preserve authenticated owner and resource failure prevents prepare", async () => {
      const f = fixture(); f.state.resourceFailure = true;
      await rejects(() => f.start(startInput({ context: { draftIds: [draftId] } })), "NATIVE_RESOURCE_NOT_FOUND", 404);
      assert.equal(f.state.operations[0].owner, owner); assert.deepEqual(f.state.operations[0].path, ["material", "info", draftId]); assert.equal(mutations(f, "prepare").length, 0);
    });
    await check("prepare carries continuation CAS and handles database configuration/CAS race without dispatch", async () => {
      for (const code of ["NATIVE_AGENT_CONFIG_REVISION_CONFLICT", "NATIVE_AGENT_REVISION_CONFLICT"]) {
        const f = fixture(); f.state.prepareError = { message: code };
        await rejects(() => f.start(startInput({ taskId, expectedRevision: 4 })), "NATIVE_AGENT_REVISION_CONFLICT", 409);
        const call = mutations(f, "prepare")[0]; assert.equal(call.parameters.p_owner, owner); assert.equal(row(row(call.parameters.p).request).expectedRevision, 4);
        assert.equal(row(row(call.parameters.p).request).taskId, taskId); assert.equal(mutations(f, "claim-turn").length, 0); assert.equal(f.state.runtimeCalls.length, 0);
      }
    });
    await check("same requestKey uses frozen SDK snapshot with no current-config read or second run", async () => {
      const f = fixture(); const previous = turn({ state: "completed" }); f.state.turns.push(previous); f.state.configError = { code: "42P01" };
      const reply = await f.start(); assert.equal(reply.continuation, undefined); await reply.response?.text();
      assert.equal(configReads(f), 0); assert.equal(mutations(f, "prepare").length, 0); assert.equal(mutations(f, "claim-turn").length, 0); assert.equal(f.state.runtimeCalls.length, 0);
      await rejects(() => f.start(startInput({ prompt: "改成另一输入" })), "NATIVE_AGENT_IDEMPOTENCY_CONFLICT", 409);
    });
    await check("prepared SDK turn is claimed through original atomic owner boundary and continuation runs once", async () => {
      const f = fixture(); const a = await f.start(); const b = await f.start();
      assert.ok(a.continuation); assert.equal(b.continuation, undefined); await Promise.all([a.continuation(), a.continuation()]); await a.response?.text(); await b.response?.text();
      assert.equal(mutations(f, "prepare").length, 1); assert.equal(mutations(f, "claim-turn").length, 1); assert.equal(f.state.runtimeCalls.length, 1);
      assert.equal(f.state.runtimeCalls[0].configSnapshot.configHash, configHash); assert.equal(f.state.runtimeCalls[0].ownerId, owner);
    });
    await check("concurrent prepared readers honor one atomic shouldExecute grant and cannot double-dispatch", async () => {
      const f = fixture(); f.state.turns.push(turn({ state: "prepared" }));
      const replies = await Promise.all([f.start(), f.start()]);
      assert.equal(replies.filter(reply => reply.continuation).length, 1);
      await Promise.all(replies.map(reply => reply.continuation?.())); await Promise.all(replies.map(reply => reply.response?.text()));
      assert.equal(f.state.runtimeCalls.length, 1); assert.equal(mutations(f, "prepare").length, 0); assert.equal(configReads(f), 0);
    });
    await check("expired unknown SDK task observes state without reading or reconciling legacy chat attempts", async () => {
      const f = fixture(); f.state.turns.push(turn({ state: "running", lease_expires_at: "2000-01-01T00:00:00Z" }));
      const response = await f.service.streamNativeAgentTask(user, f.db, taskId, 0, f.options); await response.text();
      assert.equal(mutations(f, "observe-unknown").length, 1); assert.equal(f.state.queries.some(query => query.table === "llm_request_attempts"), false);
      assert.equal(f.state.rpcCalls.some(call => call.name === "reconcile_native_agent_main_atomic"), false); assert.equal(f.state.runtimeCalls.length, 0);
    });
    await check("owner task read, privilege denial and original runner CAS block dispatch", async () => {
      const absent = fixture(); absent.state.tasks[0].owner_id = otherOwner; await rejects(() => absent.service.streamNativeAgentTask(user, absent.db, taskId, 0, absent.options), "NATIVE_AGENT_NOT_FOUND", 404);
      const denied = fixture(); denied.state.refuseNativeAccess = true; await rejects(() => denied.start(), "PUBLISH_CENTER_FORBIDDEN", 403); assert.equal(configReads(denied), 0);
      const changed = fixture(); changed.state.turns.push(turn({ state: "prepared" })); changed.state.atomicError = { message: "NATIVE_AGENT_RUNNER_CHANGED" };
      await rejects(() => changed.start(), "NATIVE_AGENT_RUNNER_CHANGED", 409); assert.equal(changed.state.runtimeCalls.length, 0);
      for (const query of absent.state.queries.filter(item => item.table === "pub_native_agent_tasks")) assert.ok(query.filters.some(([key, value]) => key === "owner_id" && value === owner));
    });
    await check("runtime GET never grants readiness or approval for absent configuration or unverified wallet safety", async () => {
      const empty = fixture(); empty.state.configRows = []; const emptyResult = row((await empty.runtime()).data); assert.equal(emptyResult.ready, false); assert.equal(emptyResult.approval, null);
      for (const broken of [{ error: { code: "42883" }, data: safety() }, { error: null, data: { ...safety(), databaseVerified: false } }]) {
        const f = fixture(); f.state.safetyError = broken.error; f.state.safetyData = broken.data; const result = row((await f.runtime()).data);
        assert.equal(result.ready, false); assert.equal(result.approval, null); assert.equal(row(result.capabilities).saveDraft, false); assert.equal(f.state.runtimeCalls.length, 0);
      }
      const missing = fixture(); missing.state.configError = { code: "42P01" }; await rejects(() => missing.runtime(), "NATIVE_AGENT_RUNTIME_SCHEMA_REQUIRED", 503);
      const ready = fixture(); const response = row((await ready.runtime()).data); assert.equal(response.ready, true); assert.deepEqual(response.approval, startInput().runtimeApproval);
    });
    await check("production SDK adapter feeds sanitized owned draft results back and persists zero-cost tool receipt", async () => {
      const f = fixture(); f.state.turns.push(turn()); let result: unknown;
      f.state.script = async (input, ports) => { result = await ports.readDraft({ draftId, version: 2 }, toolContext(input)); return complete(); };
      await f.run(); assert.deepEqual(result, { id: draftId, title: "原标题", body: "原正文", nativeRevision: 2, nativeMetadataRevision: 1, collectionId: null, contentType: "image", topics: [], platforms: [] });
      assert.equal(JSON.stringify(result).includes("signed.invalid"), false); assert.equal(f.state.operations[0].owner, owner);
      const saved = row(mutations(f, "finish-call")[0].parameters.p); assert.equal(saved.chargedCredits, "0.000000"); assert.deepEqual(saved.result, result);
    });
    await check("forged tool owner/task and stale draft revision freeze without a successful tool receipt", async () => {
      for (const patch of [{ ownerId: otherOwner }, { taskId: crypto.randomUUID() }]) {
        const f = fixture(); f.state.turns.push(turn()); f.state.script = async (input, ports) => { await ports.readDraft({ draftId }, { ...toolContext(input), ...patch }); return complete(); };
        await f.run(); assert.equal(f.state.operations.length, 0); assert.equal(mutations(f, "finish-call").length, 0); assert.equal(f.state.turns[0].state, "unknown");
      }
      const stale = fixture(); stale.state.turns.push(turn()); stale.state.script = async (input, ports) => { await ports.readDraft({ draftId, version: 1 }, toolContext(input)); return complete(); };
      await stale.run(); assert.equal(mutations(stale, "finish-call").length, 0); assert.equal(stale.state.turns[0].state, "unknown");
    });
    await check("save-draft production tool passes owner/idempotency/CAS to original core atomic mutation", async () => {
      const f = fixture(); f.state.turns.push(turn());
      f.state.script = async (input, ports) => { const result = await ports.saveDraft(saveArgs(), toolContext(input)); assert.equal(row(result).draftId, draftId); return complete(); };
      await f.run(); const call = f.state.rpcCalls.find(item => item.name === "mutate_native_core_atomic"); assert.ok(call); assert.equal(call.parameters.p_user_id, owner);
      const payload = row(call.parameters.p_input); assert.equal(payload.action, "save-native-draft"); assert.ok(String(payload.requestKey).startsWith("native-sdk:" + turnId + ":"));
      assert.equal(row(row(payload.save).base).expectedRevision, 0); assert.equal(row(payload.save).expectedMetadataRevision, 0); assert.equal(mutations(f, "finish-call").length, 1);
    });
    await check("editing existing draft retains original media/targets/metadata and owner-scoped revision reads", async () => {
      const f = fixture(); f.state.turns.push(turn());
      const mediaId = crypto.randomUUID();
      const previous = draftContracts.PublishingV2DraftInputSchema.parse({ schemaVersion: 2, collectionId: null, contentType: "image", title: "旧标题", body: "旧正文", topics: [],
        media: [{ id: mediaId, role: "image", fileName: "owned.png", size: 123, type: "image/png", lastModified: 1, source: "local_file", requiresReselection: true }],
        targets: [{ id: crypto.randomUUID(), accountId: crypto.randomUUID(), scheduledAt: null, platform: "xhs", options: {}, mediaIds: [mediaId] }] });
      const metadata = operationContracts.NativeDraftMetadataSchema.parse({ schemaVersion: 2, media: [], coverMediaId: null, accountTypes: ["xhs"], maxUseCountByAccountType: { xhs: 999999 } });
      f.state.versionRows = [{ user_id: owner, draft_id: draftId, version: 2, payload: previous }];
      f.state.metadataRows = [{ owner_id: owner, draft_id: draftId, draft_version: 2, revision: 1, payload: metadata }];
      f.state.script = async (input, ports) => { await ports.saveDraft(saveArgs({ draftId, expectedRevision: 2, expectedMetadataRevision: 1 }), toolContext(input)); return complete(); };
      await f.run();
      const saved = row(f.state.rpcCalls.find(call => call.name === "mutate_native_core_atomic")?.parameters.p_input), save = row(saved.save), base = row(save.base);
      assert.deepEqual(row(base.draft).media, previous.media); assert.deepEqual(row(base.draft).targets, previous.targets); assert.deepEqual(save.metadata, metadata);
      assert.equal(base.id, draftId); assert.equal(base.expectedRevision, 2); assert.equal(save.expectedMetadataRevision, 1);
      const versionQuery = f.state.queries.find(item => item.table === "pub2_draft_versions"), metadataQuery = f.state.queries.find(item => item.table === "pub_native_draft_meta");
      assert.ok(versionQuery?.filters.some(([key, value]) => key === "user_id" && value === owner)); assert.ok(versionQuery?.filters.some(([key, value]) => key === "version" && value === 2));
      assert.ok(metadataQuery?.filters.some(([key, value]) => key === "owner_id" && value === owner)); assert.equal(f.state.turns[0].state, "completed");
    });
    await check("stale metadata revision blocks the original draft write and freezes the tool turn", async () => {
      const f = fixture(); f.state.turns.push(turn());
      f.state.versionRows = [{ user_id: owner, draft_id: draftId, version: 2, payload: { schemaVersion: 2, collectionId: null, contentType: "image", title: "旧稿", body: "原文", topics: [], media: [], targets: [] } }];
      f.state.metadataRows = [{ owner_id: owner, draft_id: draftId, draft_version: 2, revision: 2 }];
      f.state.script = async (input, ports) => { await ports.saveDraft(saveArgs({ draftId, expectedRevision: 2, expectedMetadataRevision: 1 }), toolContext(input)); return complete(); };
      await f.run(); assert.equal(f.state.rpcCalls.some(call => call.name === "mutate_native_core_atomic"), false); assert.equal(mutations(f, "finish-call").length, 0); assert.equal(f.state.turns[0].state, "unknown");
    });
    await check("model turn SQL budget reservation precedes wallet primitive and provider entry; full receipt reaches SQL", async () => {
      const f = fixture(); f.state.turns.push(turn()); f.state.script = async (input, ports) => { const response = await ports.modelCall(modelCall(input)); assert.equal((await response.json()).id, "msg_fixture"); return complete(); };
      await f.run();
      const order = f.state.order; assert.ok(order.indexOf("sql:reserve-call") < order.indexOf("wallet-reserve")); assert.ok(order.indexOf("wallet-reserve") < order.indexOf("provider-mark"));
      assert.ok(order.indexOf("provider-mark") < order.indexOf("transport-primitive")); assert.ok(order.indexOf("attempt-finalize:succeeded") < order.indexOf("sql:finish-call"));
      assert.equal(f.state.reserves, 1); assert.equal(f.state.settlements, 1); assert.equal(f.state.providerEntries, 1);
      const result = row(row(mutations(f, "finish-call")[0].parameters.p).result), receipt = row(result.receipt);
      assert.equal(receipt.ownerId, owner); assert.equal(receipt.taskId, taskId); assert.equal(receipt.turnId, turnId); assert.equal(receipt.configHash, configHash); assert.equal(receipt.modelId, modelId);
      assert.equal(receipt.operationId, "offline-operation-1"); assert.equal(receipt.creditsCharged, 0.25); assert.equal(row(receipt.usage).output_tokens, 10);
      assert.equal(typeof receipt.requestHash, "string"); assert.equal(typeof receipt.priceSnapshotHash, "string"); assert.equal(typeof row(result.delivery).body, "string");
      assert.equal(row(mutations(f, "finish-call")[0].parameters.p).chargedCredits, "0.250000"); assert.equal(f.state.turns[0].state, "completed");
    });
    await check("same completed model call replays saved delivery without another provider or wallet mutation", async () => {
      const f = fixture(); f.state.turns.push(turn());
      f.state.script = async (input, ports) => { const call = modelCall(input); const first = await ports.modelCall(call), second = await ports.modelCall(call); assert.deepEqual(await first.json(), await second.json()); return complete(); };
      await f.run(); assert.equal(f.state.providerEntries, 1); assert.equal(f.state.reserves, 1); assert.equal(f.state.settlements, 1); assert.equal(mutations(f, "finish-call").length, 1);
    });
    await check("SQL budget rejection blocks shared wallet primitive, credentials and provider; never reports completed", async () => {
      const f = fixture(); f.state.turns.push(turn()); f.state.reserveDenied = true; f.state.script = async (input, ports) => { await ports.modelCall(modelCall(input)); return complete(); };
      await f.run(); assert.equal(f.state.reserves, 0); assert.equal(f.state.secrets, 0); assert.equal(f.state.providerEntries, 0); assert.equal(f.state.settlements, 0);
      assert.equal(f.state.turns[0].state, "unknown"); assert.equal(mutations(f, "finish").length, 0);
    });
    await check("unknown provider outcome freezes persisted turn, keeps reservation and blocks another provider entry", async () => {
      const f = fixture(); f.state.turns.push(turn()); f.state.transportUnknown = true; f.state.script = async (input, ports) => { await ports.modelCall(modelCall(input)); return complete(); };
      await f.run(); assert.equal(f.state.turns[0].state, "unknown"); assert.equal(f.state.providerEntries, 1); assert.equal(f.state.reserves, 1); assert.equal(f.state.releases, 0);
      assert.equal(f.state.settlements, 0); assert.equal(mutations(f, "finish-call").length, 0);
      assert.ok([...f.state.attemptRecords.values()].some(record => record.state === "failed_unknown"));
      await f.run(); assert.equal(f.state.providerEntries, 1); assert.equal(f.state.reserves, 1); assert.equal(mutations(f, "save-session").length, 0);
    });
    await check("persisted SDK session/checkpoint hash resumes unchanged and new checkpoint saves before finish", async () => {
      const f = fixture(); f.state.turns.push(turn()); f.state.sessions = [{ owner_id: owner, task_id: taskId, session_id: sessionId, turn_id: crypto.randomUUID(), checkpoint_hash: checkpoint }];
      f.state.script = async input => { assert.equal(input.resumeSessionId, sessionId); assert.equal(input.resumeCheckpointHash, checkpoint); return { ...complete(), checkpointHash: "d".repeat(64) }; };
      await f.run(); assert.equal(row(mutations(f, "save-session")[0].parameters.p).checkpointHash, "d".repeat(64));
      assert.ok(f.state.order.indexOf("sql:save-session") < f.state.order.indexOf("sql:finish"));
      const sessionQuery = f.state.queries.find(item => item.table === "pub_native_agent_runtime_sessions"); assert.ok(sessionQuery?.filters.some(([column, value]) => column === "owner_id" && value === owner));
    });
    await check("session-less or unknown SDK result freezes instead of saving a fabricated checkpoint", async () => {
      for (const outcome of [{ ...complete(), checkpointHash: null }, { ...complete(), state: "unknown" as const }]) {
        const f = fixture(); f.state.turns.push(turn()); f.state.script = async () => outcome; await f.run();
        assert.equal(mutations(f, "save-session").length, 0); assert.equal(mutations(f, "finish").length, 0); assert.equal(f.state.turns[0].state, "unknown");
      }
    });
    await check("real checkpoint reader hashes actual transcript bytes rather than rendered assistant text", async () => {
      const base = path.resolve(root, "../../../in-memory-checkpoint"), bytes = Buffer.from('{"type":"user","message":"原稿"}\n{"type":"assistant","message":"改写结果"}\n');
      const projects = path.join(base, "home", ".claude", "projects"), project = path.join(projects, "fixture"), filename = path.join(project, sessionId + ".jsonl");
      let symlink = false;
      const stat = (name: string) => ({ isSymbolicLink: () => symlink && name === filename, isFile: () => name === filename, ino: 1, dev: 1, size: bytes.length, mtimeMs: 1 });
      const fs = { async lstat(name: string) { return stat(name); }, async realpath(name: string) { return name; },
        async readdir(directory: string) { return directory === projects ? [{ name: "fixture", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }]
          : [{ name: sessionId + ".jsonl", isSymbolicLink: () => symlink, isDirectory: () => false, isFile: () => true }]; },
        async open(name: string) { assert.equal(name, filename); return { async stat() { return stat(filename); }, async readFile() { return bytes; }, async close() {} }; } };
      const checkpointModule = productionModule("src/lib/server/native-agent-runtime/checkpoint.ts", { "node:crypto": crypto, "node:path": path, "node:fs/promises": fs }) as unknown as { readNativeAgentSdkCheckpoint(directory: string, session: string): Promise<string> };
      assert.equal(await checkpointModule.readNativeAgentSdkCheckpoint(base, sessionId), hash(bytes)); assert.notEqual(hash(bytes), hash("改写结果"));
      symlink = true; await assert.rejects(() => checkpointModule.readNativeAgentSdkCheckpoint(base, sessionId), /SYMLINK_DENIED/u);
    });
    assert.equal(realNetwork, 0);
    console.log(JSON.stringify({ ok: true, checks, checkCount: checks.length, realNetworkCalls: realNetwork, liveDatabaseCalls: 0, paidProviderCalls: 0,
      productionModulesExecuted: ["native-agent-service", "native-agent-sdk-service", "native-agent-model-gateway", "native-agent-runtime/checkpoint"],
      boundaries: "in-memory DB/owner resource readers, wallet primitives, provider transport, SDK process, checkpoint filesystem; actual production functions and protocol parser executed",
      limitations: "does not apply SQL, launch the real SDK, build, browse, access live configuration, or prove a live financial/provider outcome" }, null, 2));
  } finally { globalThis.fetch = priorFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
