import assert from "node:assert/strict";
import test from "node:test";
import type { AuthUser } from "../src/lib/api-middleware";
import {
  prepareNativeAiAction, decideNativeAiAction, runNativeAiAction, reconcileNativeAiAction,
  prepareNativeAiBatch, advanceNativeAiBatch, nativeAiBatchProjection,
  prepareNativeAgentPlanningAction, readNativeAgentPlanning, executeNativeAiOperation,
  type NativeAiServiceOptions,
} from "../src/lib/server/native-ai-service";
import { NativeAiActionSnapshotSchema, NativeAiActionDtoSchema, nativeAiHash, nativeAiRequestKey, type NativeAiActionDto, type NativeAiActionSnapshot, type NativeAiBatchResult, type NativeAiBatchSnapshot, type NativeAiTool } from "../src/lib/native-ai-contract";
import { compileNativeAiMainAction, invokeNativeAiMain } from "../src/lib/server/native-ai-main-adapter";
import { startNativeAgentTurn, type NativeAgentServiceOptions } from "../src/lib/server/native-agent-service";
import { composeLlmRequestMessages, buildLlmChatRequest } from "../src/lib/server/llm-standard-request-preparation";
import { clientChatHistory } from "../src/lib/server/agent-chat-prompt-authority";
import { prepareContext, type ChatMessage } from "../src/lib/llm-context";
import { buildSelectedModelBillingSnapshot } from "../src/lib/llm-billing";
import { quoteLlmStreamReservation } from "../src/lib/llm-credit-reservation";

type Row = Record<string, unknown>;
type DB = Parameters<typeof prepareNativeAiAction>[1];
const uuid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A: AuthUser = { id: uuid(1), role: "user", email: "a@example.invalid" };
const B: AuthUser = { id: uuid(2), role: "user", email: "b@example.invalid" };
const stamp = "2026-11-10T00:00:00.000Z", collectionId = uuid(3), scope = { kind: "agent", taskId: uuid(4), turnId: uuid(5) } as const;
const context = { origin: "http://127.0.0.1:5000", cookies: { get: () => undefined }, headers: new Headers({ cookie: "fixture-session=owner-a" }) };
const originalFetch = globalThis.fetch;
let networkCalls = 0;
test.before(() => { globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN_IN_AI_SERVICE_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });
const obj = (value: unknown): Row => value as Row;
const copy = <T>(value: T): T => structuredClone(value);
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const imageTool = (count = 1): Extract<NativeAiTool, { kind: "generate_image" }> => ({ kind: "generate_image", args: { modelId: "pm_image_fixture", prompt: "原始创作要求🙂", aspectRatio: "1:1", resolution: "1K", referenceAssets: [], count } });

/** This fixture provides durable RPC evidence; it does not claim to test PostgreSQL locking. */
function fixture() {
  const tables: Record<string, Row[]> = {
    pub2_collections: [{ id: collectionId, user_id: A.id, revision: 2, archived: false }],
    pub2_drafts: [], pub2_draft_versions: [], pub_native_draft_meta: [], pub_native_ai_actions: [],
    pub_native_ai_requests: [], image_generation_requests: [], llm_request_attempts: [],
  };
  const records = new Map<string, { owner: string; key: string; action: NativeAiActionDto; snapshot: NativeAiActionSnapshot }>();
  const batches = new Map<string, { owner: string; result: NativeAiBatchResult }>();
  const evidence = new Map<string, NativeAiActionDto["slots"][number]["receipt"]>();
  const rpcCalls: { name: string; owner: string; input: Row }[] = [], reads: { table: string; filters: [string, unknown][] }[] = [];
  const compiled: Row[] = [], invoked: { consumer: string; wire: Row }[] = [], localCalls: Row[] = [];
  let permissionCalls = 0, denyAt = Infinity, lookupError: unknown = null;
  let onInvoke: ((wire: Row) => Promise<void>) | undefined;
  function dto(owner: string, key: string, actionId: string, actionScope: NativeAiActionDto["scope"], snapshot: NativeAiActionSnapshot, actionHash: string) {
    const action = NativeAiActionDtoSchema.parse({ id: actionId, scope: actionScope, revision: 1, state: "proposed", kind: snapshot.kind, actionHash, args: snapshot.args, quote: snapshot.quote, slots: snapshot.slots.map(slot => ({ slot: slot.slot, requestKey: slot.requestKey, consumer: slot.consumer, state: "proposed", dispatchId: null, receipt: null })), createdAt: stamp, updatedAt: stamp });
    records.set(actionId, { owner, key, action, snapshot: copy(snapshot) });
    tables.pub_native_ai_actions.push({ id: actionId, owner_id: owner, snapshot: copy(snapshot) });
    return action;
  }
  function update(action: NativeAiActionDto) {
    action.revision++;
    action.state = action.slots.every(slot => slot.state === "succeeded") ? "succeeded" : action.slots.some(slot => slot.state === "unknown") ? "unknown" : action.slots.some(slot => slot.state === "approved") ? "approved" : action.slots[0].state;
  }
  function batchResult(batchId: string) {
    const stored = batches.get(batchId); if (!stored) throw new Error("fixture batch missing");
    const result = copy(stored.result);
    result.actions = [...records.values()].filter(record => record.owner === stored.owner && record.action.scope.kind === "batch" && record.action.scope.batchId === batchId).map(record => copy(record.action));
    result.items = result.items.map(item => ({ ...item, actionIds: result.actions.filter(action => action.scope.kind === "batch" && action.scope.itemId === item.id).map(action => action.id) }));
    return result;
  }
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let ordering: { field: string; ascending: boolean } | undefined, maximum = Infinity;
      function execute(single: boolean) {
        reads.push({ table, filters: [...filters] });
        let values = (tables[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value));
        if (ordering) { const sort = ordering; values = [...values].sort((a, b) => String(a[sort.field]).localeCompare(String(b[sort.field])) * (sort.ascending ? 1 : -1)); }
        return { data: copy(single ? values[0] ?? null : values.slice(0, maximum)), error: null };
      }
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        order(field: string, options: { ascending: boolean }) { ordering = { field, ascending: options.ascending }; return query; },
        limit(value: number) { maximum = value; return query; },
        async maybeSingle() { return execute(true); },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name: string, raw: unknown) {
      const args = raw as { p_user_id: string; p_input: Row }, p = args.p_input, owner = args.p_user_id;
      rpcCalls.push({ name, owner, input: copy(p) });
      const fail = (message: string) => ({ data: null, error: { message } });
      if (name === "read_native_ai_atomic") {
        if (lookupError) return { data: null, error: lookupError };
        if (p.action === "action-by-request-key") {
          const record = [...records.values()].find(row => row.owner === owner && row.key === p.requestKey);
          return record ? { data: { action: copy(record.action) }, error: null } : fail("NATIVE_AI_NOT_FOUND");
        }
        if (p.action === "action") { const record = records.get(String(p.actionId)); return record?.owner === owner ? { data: { action: copy(record.action) }, error: null } : fail("NATIVE_AI_NOT_FOUND"); }
        if (p.action === "consumer-invocation") {
          const record = [...records.values()].find(row => row.owner === owner && row.snapshot.slots.some(slot => slot.consumer === p.consumer && slot.requestKey === p.mainRequestKey));
          const slot = record?.action.slots.find(slot => slot.requestKey === p.mainRequestKey);
          return { data: record && slot ? { found: true, action: copy(record.action), snapshot: copy(record.snapshot), slot: copy(slot) } : { found: false }, error: null };
        }
        if (p.action === "actions-for-task") return { data: { items: [...records.values()].filter(row => row.owner === owner && row.action.scope.kind === "agent" && row.action.scope.taskId === p.taskId).map(row => copy(row.action)), total: records.size }, error: null };
        if (p.action === "batch") { const stored = batches.get(String(p.batchId)); return stored?.owner === owner ? { data: batchResult(String(p.batchId)), error: null } : fail("NATIVE_AI_NOT_FOUND"); }
        throw new Error(`fixture unexpected read ${String(p.action)}`);
      }
      assert.equal(name, "mutate_native_ai_atomic");
      if (p.action === "prepare-action") {
        const action = dto(owner, String(p.requestKey), String(p.actionId), p.scope as NativeAiActionDto["scope"], p.snapshot as NativeAiActionSnapshot, String(p.actionHash));
        return { data: { action: copy(action) }, error: null };
      }
      if (p.action === "prepare-batch") {
        const snapshot = p.snapshot as NativeAiBatchSnapshot, batchId = String(p.batchId);
        const items = (p.items as Row[]).map(item => {
          const initial = obj(item.initialAction), actionId = String(initial.id);
          dto(owner, `batch-item:${String(item.id)}`, actionId, { kind: "batch", batchId, itemId: String(item.id) }, initial.snapshot as NativeAiActionSnapshot, String(initial.actionHash));
          return { id: String(item.id), batchId, ordinal: Number(item.ordinal), revision: 1, state: "proposed" as const, rootActionId: actionId, actionIds: [actionId], createdAt: stamp, updatedAt: stamp };
        });
        const result: NativeAiBatchResult = { batch: { id: batchId, revision: 1, state: "proposed", mode: snapshot.mode, quantity: snapshot.quantity, manifestHash: await nativeAiHash(snapshot), snapshot: copy(snapshot), createdAt: stamp, updatedAt: stamp }, items, actions: [] };
        batches.set(batchId, { owner, result });
        const current = batchResult(batchId);
        tables.pub_native_ai_requests.push({ owner_id: owner, request_key: p.requestKey, request_payload: { action: "prepare-batch", snapshot: copy(snapshot) }, result: copy(current) });
        return { data: current, error: null };
      }
      const record = records.get(String(p.actionId ?? p.proposalId));
      if (!record || record.owner !== owner) return fail("NATIVE_AI_NOT_FOUND");
      const action = record.action;
      if (p.action === "decide") {
        if (p.expectedRevision !== action.revision) return fail("NATIVE_AI_REVISION_CONFLICT");
        action.state = p.decision === "approve" ? "approved" : "rejected";
        action.slots.forEach(slot => { slot.state = action.state; }); action.revision++;
        return { data: { action: copy(action) }, error: null };
      }
      if (p.action === "claim-dispatch") {
        const slot = action.slots[Number(p.slot)];
        if (slot.state !== "approved") return { data: { action: copy(action), shouldDispatch: false }, error: null };
        slot.state = "dispatch_claimed"; slot.dispatchId = uuid(100 + Number(p.slot)); update(action);
        return { data: { action: copy(action), slot: copy(slot), shouldDispatch: true, dispatchId: slot.dispatchId }, error: null };
      }
      if (p.action === "reconcile") {
        const slot = action.slots[Number(p.slot)], receipt = evidence.get(slot.requestKey);
        slot.receipt = copy(receipt ?? null); slot.state = receipt?.status === "succeeded" ? "succeeded" : "unknown"; update(action);
        return { data: { action: copy(action) }, error: null };
      }
      throw new Error(`fixture unexpected mutation ${String(p.action)}`);
    },
  } as unknown as DB;
  const options: NativeAiServiceOptions = {
    access: async () => { permissionCalls++; if (permissionCalls >= denyAt) throw new Error("fixture permission revoked"); return { revision: 7, checksum: "fixture", featureNavigationKeys: ["publish_center"] } as Awaited<ReturnType<NonNullable<NativeAiServiceOptions["access"]>>>; },
    compileMain: async (_db, actor, actionId, tool, revision, compilerOptions = {}) => {
      compiled.push({ owner: actor, actionId, tool: copy(tool), options: copy({ ...compilerOptions, dependencies: undefined }) });
      const count = tool.kind === "generate_image" ? tool.args.count : 1, consumer = tool.kind === "plan_text" ? "main_llm" : tool.kind === "generate_image" ? "main_image" : "main_video";
      const wires = Array.from({ length: count }, (_, slot) => compilerOptions.plannerWire ?? { modelId: tool.args.modelId, prompt: tool.args.prompt, clientIdempotencyKey: nativeAiRequestKey(actionId, slot) });
      return NativeAiActionSnapshotSchema.parse({ version: "native-ai-action.v1", kind: tool.kind, args: tool.args, sourceActionId: compilerOptions.sourceActionId ?? null, resources: [], quote: { unit: tool.kind === "plan_text" ? "credits" : "CNY", quotedAmount: tool.kind === "plan_text" ? "0.25" : "0.5", maxAmount: compilerOptions.maxAmount ?? (tool.kind === "plan_text" ? "0.25" : "1"), priceHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" }, surface: tool.kind === "plan_text" ? "native-agent-text" : tool.kind === "generate_image" ? "publish-center-image" : "publish-center-video", permissionRevision: revision, slots: await Promise.all(wires.map(async (wireRequest, slot) => ({ slot, consumer, requestKey: String(wireRequest.client_request_id ?? wireRequest.clientIdempotencyKey), wireRequest, wireRequestHash: await nativeAiHash(wireRequest) }))) });
    },
    invokeMain: async (consumer, wire) => { invoked.push({ consumer, wire: copy(wire) }); await onInvoke?.(wire); },
    nativeOperation: async (_user, _db, method, path, _query, body) => { assert.equal(method, "POST"); assert.deepEqual(path, ["core"]); localCalls.push(copy(obj(body))); return { data: { status: "not evidence" } }; },
  };
  const prepare = (tool: NativeAiTool = imageTool(), key = "fixture-action-request", user = A) => prepareNativeAiAction(user, db, { requestKey: key, scope, tool }, options);
  const approve = (action: NativeAiActionDto) => decideNativeAiAction(A, db, { proposalId: action.id, expectedRevision: action.revision, decision: "approve", requestKey: `approve:${action.id}` }, options);
  return { db, options, tables, records, batches, evidence, rpcCalls, reads, compiled, invoked, localCalls, prepare, approve, counts: () => ({ permissionCalls }), denyAt: (n: number) => { denyAt = n; }, failLookup: (error: unknown) => { lookupError = error; }, onInvoke: (callback: (wire: Row) => Promise<void>) => { onInvoke = callback; }, batchResult };
}

test("successful action replay precedes new prices/configuration and owner same-key arguments cannot be substituted", async () => {
  const f = fixture(), tool = imageTool(), first = await f.prepare(tool);
  const stored = f.records.get(first.id)!; stored.action.state = "succeeded";
  f.options.compileMain = async () => { throw new Error("changed catalog must not be consulted"); };
  assert.equal((await f.prepare(tool)).id, first.id); assert.equal(f.compiled.length, 1);
  const changed = imageTool(); changed.args.prompt = "different";
  await assert.rejects(f.prepare(changed), errorCode("NATIVE_AI_IDEMPOTENCY_CONFLICT"));
  await assert.rejects(prepareNativeAiAction(A, f.db, { requestKey: "fixture-action-request", scope: { ...scope, turnId: uuid(90) }, tool }, f.options), errorCode("NATIVE_AI_IDEMPOTENCY_CONFLICT"));
  f.options.compileMain = fixture().options.compileMain;
  const secondOwner = await f.prepare(tool, "fixture-action-request", B); assert.notEqual(secondOwner.id, first.id);
  assert.equal(f.rpcCalls.some(call => call.owner === B.id && call.input.action === "prepare-action"), true);
});

test("ack lookup not-found is null while a database error never becomes a new proposal or null", async () => {
  const f = fixture();
  const read = () => executeNativeAiOperation(A, f.db, "GET", ["ai", "actions"], new URLSearchParams({ requestKey: "fixture-lost-ack" }), undefined, context, f.options);
  assert.deepEqual((await read()).data, { action: null }); assert.equal(f.compiled.length, 0);
  f.failLookup({ code: "08006", message: "connection lost" });
  await assert.rejects(read(), errorCode("NATIVE_AI_STATE_UNAVAILABLE"));
  await assert.rejects(f.prepare(), errorCode("NATIVE_AI_STATE_UNAVAILABLE"));
  assert.equal(f.compiled.length, 0); assert.equal(f.rpcCalls.some(call => call.name.startsWith("mutate")), false);
});

test("decision accepts only its original proposal and CAS; replacement args never reach the ledger", async () => {
  const f = fixture(), action = await f.prepare();
  const before = f.rpcCalls.length;
  await assert.rejects(decideNativeAiAction(A, f.db, { proposalId: action.id, expectedRevision: 1, decision: "approve", requestKey: "decision-fixture", args: { prompt: "injected" } }, f.options), errorCode("NATIVE_AI_INPUT_INVALID"));
  assert.equal(f.rpcCalls.length, before);
  await assert.rejects(decideNativeAiAction(B, f.db, { proposalId: action.id, expectedRevision: 1, decision: "approve", requestKey: "decision-fixture" }, f.options), errorCode("NATIVE_AI_NOT_FOUND"));
  await f.approve(action);
  await assert.rejects(f.approve(action), errorCode("NATIVE_AI_REVISION_CONFLICT"));
  assert.deepEqual(f.records.get(action.id)!.action.args, action.args);
});

test("permission is checked immediately before claim and mutable public DTO edits cannot change frozen execution", async () => {
  const f = fixture(), action = await f.approve(await f.prepare());
  action.args.prompt = "mutated DTO";
  await runNativeAiAction(A, f.db, action.id, context, f.options);
  assert.equal(f.invoked.length, 1); assert.equal(f.invoked[0].wire.prompt, "原始创作要求🙂");
  const g = fixture(), approved = await g.approve(await g.prepare());
  g.denyAt(g.counts().permissionCalls + 3);
  await assert.rejects(runNativeAiAction(A, g.db, approved.id, context, g.options), /fixture permission revoked/);
  assert.equal(g.invoked.length, 0); assert.equal(g.rpcCalls.some(call => call.input.action === "claim-dispatch"), false);
});

test("two slots dispatch once each; HTTP-like success is not durable evidence and unknown only reconciles", async () => {
  const f = fixture(), action = await f.approve(await f.prepare(imageTool(2)));
  let handlerCalls = 0;
  const capture = f.options.invokeMain!;
  f.options.invokeMain = async (consumer, wire, headers) => {
    await capture(consumer, wire, headers);
    await invokeNativeAiMain(consumer, wire, headers, { main_image: async () => { handlerCalls++; return new Response('{"success":true,"status":"completed"}', { status: 200 }); } });
  };
  await runNativeAiAction(A, f.db, action.id, context, f.options);
  assert.equal(f.invoked.length, 2); assert.equal(handlerCalls, 2); assert.notEqual(f.invoked[0].wire.clientIdempotencyKey, f.invoked[1].wire.clientIdempotencyKey);
  assert.equal(f.records.get(action.id)!.action.state, "unknown");
  const beforeClaims = f.rpcCalls.filter(call => call.input.action === "claim-dispatch").length;
  await runNativeAiAction(A, f.db, action.id, context, f.options);
  await reconcileNativeAiAction(A, f.db, action.id, "fixture-reconcile", f.options);
  assert.equal(f.invoked.length, 2); assert.equal(f.rpcCalls.filter(call => call.input.action === "claim-dispatch").length, beforeClaims);
  assert.equal(handlerCalls, 2);
});

test("a thrown first dispatch stays unknown and a later entry resumes only the remaining approved slot", async () => {
  const f = fixture(), action = await f.approve(await f.prepare(imageTool(2)));
  f.onInvoke(async () => { throw new Error("fixture ack lost"); });
  await assert.rejects(runNativeAiAction(A, f.db, action.id, context, f.options), /fixture ack lost/);
  assert.deepEqual(f.records.get(action.id)!.action.slots.map(slot => slot.state), ["unknown", "approved"]);
  f.onInvoke(async wire => { const key = String(wire.clientIdempotencyKey); f.evidence.set(key, { source: "main_image", id: "receipt-2", status: "succeeded", resultRefs: [{ kind: "image_record", id: "record-2" }] }); });
  await runNativeAiAction(A, f.db, action.id, context, f.options);
  assert.equal(f.invoked.length, 2); assert.deepEqual(f.records.get(action.id)!.action.slots.map(slot => slot.state), ["unknown", "succeeded"]);
});

test("two concurrent runners honor atomic shouldDispatch receipts without duplicating either slot", async () => {
  const f = fixture(), action = await f.approve(await f.prepare(imageTool(2)));
  await Promise.all([runNativeAiAction(A, f.db, action.id, context, f.options), runNativeAiAction(A, f.db, action.id, context, f.options)]);
  assert.equal(f.invoked.length, 2); assert.equal(new Set(f.invoked.map(call => call.wire.clientIdempotencyKey)).size, 2);
  await assert.rejects(runNativeAiAction(B, f.db, action.id, context, f.options), errorCode("NATIVE_AI_NOT_FOUND"));
  assert.equal(f.invoked.length, 2);
});

function oldDraft(f: ReturnType<typeof fixture>) {
  const draftId = uuid(30), mediaId = uuid(31), targetId = uuid(32);
  const source = { kind: "main_asset", reference: { kind: "image_record", id: "old-image" } } as const;
  const payload = { schemaVersion: 2, collectionId, contentType: "image", title: "原稿", body: "保留正文", topics: ["原话题"], media: [{ id: mediaId, role: "image", fileName: "old.png", size: 1200, type: "image/png", lastModified: 0, hash: "b".repeat(64), source: "main_asset", requiresReselection: false, reference: source.reference }], targets: [{ id: targetId, accountId: uuid(33), platform: "xhs", options: {}, mediaIds: [mediaId], scheduledAt: null }] };
  f.tables.pub2_drafts.push({ id: draftId, user_id: A.id, revision: 4 });
  f.tables.pub2_draft_versions.push({ user_id: A.id, draft_id: draftId, version: 4, payload: copy(payload) });
  f.tables.pub_native_draft_meta.push({ owner_id: A.id, draft_id: draftId, draft_version: 4, revision: 2, payload: { media: [{ mediaId, source }] } });
  f.tables.image_generation_requests.push({ user_id: A.id, record_id: "old-image", state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", contentType: "image/png", size: 1200 } });
  const tool: NativeAiTool = { kind: "save_draft", args: { draftId, expectedRevision: 4, expectedMetadataRevision: 2, collectionId, contentType: "image", title: "新标题", body: "新正文", topics: ["原话题"], media: [{ role: "image", source }], platforms: ["xhs"] } };
  return { draftId, mediaId, payload, tool };
}

test("local draft planning keeps its original draft/target/media IDs and hash without depending on provider assets", async () => {
  const f = fixture(), old = oldDraft(f), before = copy(f.tables.pub2_draft_versions);
  const action = await f.prepare(old.tool), snapshot = f.records.get(action.id)!.snapshot;
  const base = obj(obj(snapshot.slots[0].wireRequest.save).base), draft = obj(base.draft), media = draft.media as Row[];
  assert.equal(base.id, old.draftId); assert.equal(base.expectedRevision, 4); assert.deepEqual(draft.targets, old.payload.targets);
  assert.equal(media[0].id, old.mediaId); assert.equal(media[0].hash, "b".repeat(64)); assert.equal(media[0].source, "main_asset");
  assert.equal(snapshot.quote.unit, "metadata_write"); assert.equal(snapshot.quote.maxAmount, "0");
  assert.equal(snapshot.slots[0].wireRequestHash, await nativeAiHash(snapshot.slots[0].wireRequest));
  assert.equal(f.reads.some(read => read.table === "pub3_assets"), false); assert.deepEqual(f.tables.pub2_draft_versions, before); assert.equal(f.localCalls.length, 0);
  await f.approve(action); await runNativeAiAction(A, f.db, action.id, context, f.options);
  assert.equal(f.localCalls.length, 1); assert.equal(f.invoked.length, 0);
});

test("stale source or metadata revisions and removed target media block the local proposal before mutation", async () => {
  for (const mutate of [(tool: Extract<NativeAiTool, { kind: "save_draft" }>) => { tool.args.expectedRevision = 3; }, (tool: Extract<NativeAiTool, { kind: "save_draft" }>) => { tool.args.expectedMetadataRevision = 1; }, (tool: Extract<NativeAiTool, { kind: "save_draft" }>) => { tool.args.media = []; }]) {
    const f = fixture(), old = oldDraft(f); assert.equal(old.tool.kind, "save_draft");
    mutate(old.tool as Extract<NativeAiTool, { kind: "save_draft" }>);
    await assert.rejects(f.prepare(old.tool));
    assert.equal(f.rpcCalls.some(call => call.input.action === "prepare-action"), false); assert.equal(f.invoked.length, 0); assert.equal(f.localCalls.length, 0);
  }
});

test("a changed source gets a new media identity and cannot inherit another image's stored hash", async () => {
  const f = fixture(), old = oldDraft(f); assert.equal(old.tool.kind, "save_draft");
  obj(f.tables.pub2_draft_versions[0].payload).targets = [];
  const tool = old.tool as Extract<NativeAiTool, { kind: "save_draft" }>;
  tool.args.media = [{ role: "image", source: { kind: "main_asset", reference: { kind: "image_record", id: "new-image" } } }];
  f.tables.image_generation_requests.push({ user_id: A.id, record_id: "new-image", state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", size: 333 } });
  const action = await f.prepare(tool), snapshot = f.records.get(action.id)!.snapshot;
  const media = obj(obj(obj(snapshot.slots[0].wireRequest.save).base).draft).media as Row[];
  assert.notEqual(media[0].id, old.mediaId); assert.equal(media[0].hash, undefined);
});

function batchSnapshot(): NativeAiBatchSnapshot { return { version: "native-ai-batch.v1", mode: "image_text", collectionId, prompt: "逐份策划", captionPrompt: "保留原文风格", quantity: 2, imageCount: 1, plannerModelId: "pm_chat_fixture", generationModelId: "pm_image_fixture", options: { aspectRatio: "1:1", resolution: "1K", duration: null }, platforms: ["xhs"], budget: { credits: "0.5", CNY: "1" }, savePolicy: "confirm_resolved_drafts" }; }

test("batch planning gives each item a distinct frozen key and enforces credits separately from CNY", async () => {
  const f = fixture(), snapshot = batchSnapshot(), raw = { requestKey: "fixture-batch-prepare", snapshot };
  const result = await prepareNativeAiBatch(A, f.db, raw, f.options);
  assert.equal(result.items.length, 2); assert.equal(new Set(result.actions.map(action => action.slots[0].requestKey)).size, 2);
  assert.deepEqual(result.actions.map(action => action.quote.unit), ["credits", "credits"]); assert.equal(result.batch.snapshot.budget.CNY, "1");
  assert.deepEqual(result.actions.map(action => action.quote.maxAmount), ["0.25", "0.25"]);
  assert.equal(f.invoked.length, 0); assert.equal(f.localCalls.length, 0);
  f.options.compileMain = async () => { throw new Error("replay must not reprice"); };
  assert.equal((await prepareNativeAiBatch(A, f.db, raw, f.options)).batch.id, result.batch.id);
  await assert.rejects(prepareNativeAiBatch(A, f.db, { ...raw, snapshot: { ...snapshot, prompt: "changed" } }, f.options), errorCode("NATIVE_AI_IDEMPOTENCY_CONFLICT"));
  const g = fixture();
  await assert.rejects(prepareNativeAiBatch(A, g.db, { requestKey: "fixture-over-budget", snapshot: { ...snapshot, budget: { credits: "0.49", CNY: "999" } } }, g.options));
  assert.equal(g.rpcCalls.some(call => call.input.action === "prepare-batch"), false); assert.equal(g.invoked.length, 0);
  const h = fixture();
  await assert.rejects(prepareNativeAiBatch(A, h.db, { requestKey: "fixture-cash-too-low", snapshot: { ...snapshot, budget: { credits: "999", CNY: "0" } } }, h.options));
  assert.equal(h.compiled.some(call => obj(call.tool).kind === "plan_text"), false); assert.equal(h.invoked.length, 0);
  const planner = f.records.get(result.actions[0].id)!.snapshot, wire = planner.slots[0].wireRequest;
  const parameters = { agentDeepThinkingType: 0, agentDeductDeepThink: 1, agentMaxContextRounds: 0, agentMaxContextTokens: 32768, agentMaxReplyTokens: 4096, agentTimeout: 120, agentEnableWebSearch: false, agentTemperature: undefined, agentResponseFormat: undefined };
  const composed = await composeLlmRequestMessages({ ...parameters, agentId: "__free_chat__", agentName: "", agentRow: null, mangaSkillOrchestration: null, isCanvasInternalWorkflow: false, verifiedUserId: A.id, body: wire, globalPrefix: "", messages: wire.messages, useModel: "fixture-chat", loadProfileContext: async () => "", loadSkills: async () => null });
  const providerRequest = buildLlmChatRequest("fixture-chat", composed.finalMessages as ChatMessage[], parameters, true);
  assert.ok(JSON.stringify(providerRequest.messages).includes("mediaPrompt")); assert.ok(JSON.stringify(providerRequest.messages).includes("topics")); assert.ok(JSON.stringify(providerRequest.messages).includes("保留原文风格"));
});

test("planner success is not a completed draft; media derivation remains a separate unapproved proposal", async () => {
  const f = fixture(), result = await prepareNativeAiBatch(A, f.db, { requestKey: "fixture-batch-derived", snapshot: batchSnapshot() }, f.options);
  const stored = f.batches.get(result.batch.id)!; stored.result.batch.state = "succeeded";
  for (const action of result.actions) {
    const record = f.records.get(action.id)!; record.action.state = "succeeded"; record.action.slots[0].state = "succeeded";
    record.action.slots[0].receipt = { source: "main_llm", id: `attempt:${action.id}`, status: "succeeded", resultRefs: [{ kind: "llm_attempt", id: `attempt:${action.id}` }] };
    const plan = JSON.stringify({ title: "计划标题", body: "原始文案", topics: ["话题"], mediaPrompt: "需要确认的图片描述" });
    f.tables.llm_request_attempts.push({ user_id: A.id, record_id: `attempt:${action.id}`, state: "succeeded", response_body: `data: ${JSON.stringify({ choices: [{ delta: { content: plan } }] })}\n\ndata: [DONE]\n\n` });
  }
  const projection = nativeAiBatchProjection(f.batchResult(result.batch.id));
  assert.equal(projection.workflowComplete, false); assert.equal(projection.status, "requires_action"); assert.equal(projection.items.every(item => item.draftId === null), true);
  const advanced = await advanceNativeAiBatch(A, f.db, result.batch.id, f.options);
  const generated = advanced.actions.filter(action => action.kind === "generate_image");
  assert.equal(generated.length, 2); assert.equal(generated.every(action => action.state === "proposed" && action.quote.unit === "CNY"), true);
  assert.equal(generated.every(action => f.records.get(action.id)!.snapshot.sourceActionId !== null), true);
  assert.equal(f.invoked.length, 0); assert.equal(nativeAiBatchProjection(advanced).workflowComplete, false);
  for (const action of generated) {
    const record = f.records.get(action.id)!, recordId = `generated:${action.id}`;
    record.action.state = "succeeded"; record.action.slots[0].state = "succeeded";
    record.action.slots[0].receipt = { source: "main_image", id: recordId, status: "succeeded", resultRefs: [{ kind: "image_record", id: recordId }] };
    f.tables.image_generation_requests.push({ user_id: A.id, record_id: recordId, state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", contentType: "image/png", size: 2000 } });
  }
  const afterMedia = await advanceNativeAiBatch(A, f.db, result.batch.id, f.options);
  const drafts = afterMedia.actions.filter(action => action.kind === "save_draft");
  assert.equal(drafts.length, 2); assert.equal(drafts.every(action => action.state === "proposed"), true); assert.equal(f.localCalls.length, 0);
  assert.equal(nativeAiBatchProjection(afterMedia).workflowComplete, false);
  for (const [index, draft] of drafts.entries()) {
    const approved = await f.approve(draft), key = approved.slots[0].requestKey;
    f.evidence.set(key, { source: "native_core", id: `draft-receipt:${index}`, status: "succeeded", resultRefs: [{ kind: "draft", id: uuid(200 + index) }] });
    await runNativeAiAction(A, f.db, draft.id, context, f.options);
  }
  const completed = nativeAiBatchProjection(f.batchResult(result.batch.id));
  assert.equal(completed.workflowComplete, true); assert.equal(completed.status, "completed"); assert.equal(f.localCalls.length, 2); assert.equal(f.invoked.length, 0);
});

test("decision acknowledgement work is single-use and cannot dispatch again when the callback is entered twice", async () => {
  const f = fixture(), proposed = await f.prepare();
  const result = await executeNativeAiOperation(A, f.db, "POST", ["ai", "actions", proposed.id, "decision"], new URLSearchParams(), { proposalId: proposed.id, expectedRevision: proposed.revision, decision: "approve", requestKey: "fixture-work-callback" }, context, f.options);
  assert.equal(f.invoked.length, 0); assert.ok(result.work);
  await result.work(); await result.work(); assert.equal(f.invoked.length, 1);
  assert.equal(f.records.get(proposed.id)!.action.state, "unknown");
});

function planningTurn(overrides: Row = {}) { return { id: scope.turnId, task_id: scope.taskId, owner_id: A.id, state: "prepared", lease_owner: null, response_text: "", model_public_id: "pm_chat_fixture", input_snapshot: { prompt: "本次明确规划", context: {} }, policy_snapshot: { mainRequest: { agentId: "__free_chat__", modelId: "pm_chat_fixture", model_overridden: true, stream: true, max_reply_tokens: 128, max_context_rounds: 0, max_context_tokens: 1024, client_request_id: `native-agent:${scope.turnId}:llm:0`, messages: [{ role: "system", content: "NATIVE_OPERATOR_PLAN_V1\n只做本次规划" }, { role: "user", content: "本次明确规划" }] } }, ...overrides }; }

test("explicit planning binds the original main wire once and never retroactively authorizes historical turns", async () => {
  for (const override of [{ owner_id: B.id }, { state: "completed", response_text: "既有历史" }, { lease_owner: uuid(99) }]) {
    const f = fixture(); await assert.rejects(prepareNativeAgentPlanningAction(A, f.db, planningTurn(override), "1", f.options)); assert.equal(f.compiled.length, 0);
  }
  const f = fixture(), turn = planningTurn();
  const action = await prepareNativeAgentPlanningAction(A, f.db, turn, "1", f.options);
  assert.equal(action.kind, "plan_text"); assert.equal(action.state, "dispatch_claimed");
  assert.equal(f.records.get(action.id)!.snapshot.slots[0].requestKey, `native-agent:${scope.turnId}:llm:0`);
  assert.deepEqual(f.records.get(action.id)!.snapshot.slots[0].wireRequest, obj(turn.policy_snapshot).mainRequest);
  await prepareNativeAgentPlanningAction(A, f.db, { ...turn, state: "unknown" }, "1", f.options);
  assert.equal(f.compiled.length, 1); assert.equal(f.rpcCalls.filter(call => call.input.action === "claim-dispatch").length, 1); assert.equal(f.invoked.length, 0);
  await assert.rejects(prepareNativeAgentPlanningAction(A, f.db, turn, "2", f.options), errorCode("NATIVE_AI_IDEMPOTENCY_CONFLICT"));
});

test("planning read preserves raw history and does not derive cards from unbound or invalid old text", async () => {
  const f = fixture(), turn = planningTurn(), action = await prepareNativeAgentPlanningAction(A, f.db, turn, "1", f.options);
  const record = f.records.get(action.id)!; record.action.state = "succeeded"; record.action.slots[0].state = "succeeded";
  const raw = JSON.stringify({ reply: "只展示这份计划🙂", actions: [] });
  const turns = [{ ...turn, state: "completed", response_text: raw }, { ...planningTurn({ id: uuid(97), state: "completed", response_text: "旧记录保持" }) }];
  const before = copy(turns), mutations = f.rpcCalls.filter(call => call.name.startsWith("mutate")).length;
  const result = await readNativeAgentPlanning(A, f.db, scope.taskId, turns, f.options, false);
  assert.equal(result.nativePlanningTurns.length, 1); assert.equal(result.nativePlanningTurns[0].reply, "只展示这份计划🙂"); assert.equal(result.nativePlanningTurns[0].rawTextHash.length, 64);
  assert.deepEqual(turns, before); assert.equal(f.rpcCalls.filter(call => call.name.startsWith("mutate")).length, mutations);
  turns[0].response_text = "旧版自由文本，仍然原样保留";
  const invalid = await readNativeAgentPlanning(A, f.db, scope.taskId, turns, f.options, true);
  assert.equal(invalid.nativePlanningTurns[0].reply, ""); assert.notEqual(invalid.nativePlanningTurns[0].parseError, ""); assert.deepEqual(invalid.nativePlanningTurns[0].actionIds, []);
  assert.equal(turns[0].response_text, "旧版自由文本，仍然原样保留"); assert.equal(f.invoked.length, 0);
});

test("real Agent planning payload survives clientChatHistory and the actual composer into the billed model request", async () => {
  const f = fixture(), accountId = uuid(501), draftId = uuid(502), assetId = uuid(503);
  const task = { id: scope.taskId, owner_id: A.id, title: "原任务", revision: 10, next_seq: 0, status: "completed", archived: false, created_at: stamp, updated_at: stamp };
  f.tables.pub_native_agent_tasks = [task];
  f.tables.pub_native_agent_turns = Array.from({ length: 10 }, (_, index) => ({ id: uuid(600 + index), owner_id: A.id, task_id: task.id, state: "completed", input_snapshot: { prompt: `历史提问${index}` }, response_text: `历史原文${index}`, created_at: `2026-11-10T00:00:${String(index).padStart(2, "0")}.000Z` }));
  const model = { id: uuid(700), model_name: "fixture-main-chat", token_billing_enabled: true, input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0.5, profit_margin: 20 };
  const config = { inputCostPerMillion: 1, outputCostPerMillion: 2, cachedCostPerMillion: 0.5, profitMargin: 20, creditsPerYuan: 50, tokenRoundingEnabled: false, tokenRoundingUnit: 1, tokenRoundingMin: 1, tokenRoundingMax: 1000 };
  const billing = buildSelectedModelBillingSnapshot("pm_chat_fixture", model, config); assert.ok(billing);
  f.options.compileMain = (db, actor, actionId, tool, revision, options) => compileNativeAiMainAction(db, actor, actionId, tool, revision, { ...options, dependencies: { catalog: async () => ({}), model: async () => model, selectedTextBilling: async () => billing } });
  let capturedTurn: Row | undefined;
  const agentDb = {
    from: (table: string) => f.db.from(table),
    async rpc(name: string, raw: unknown) {
      if (name !== "mutate_native_agent_atomic") throw new Error("Unexpected Agent RPC");
      const args = raw as { p_owner: string; p: Row }, p = args.p; assert.equal(args.p_owner, A.id);
      if (p.action === "prepare-turn") {
        const request = obj(p.request), turn = { id: p.turnId, task_id: task.id, owner_id: A.id, request_key: p.requestKey, state: "prepared", lease_owner: null, response_text: "", model_public_id: request.modelId, input_snapshot: copy(request), policy_snapshot: copy(p.policy), revision: 1, created_at: stamp, updated_at: stamp };
        f.tables.pub_native_agent_turns.push(turn); return { data: { task: copy(task), turn }, error: null };
      }
      if (p.action === "claim-turn") return { data: { shouldExecute: false }, error: null };
      throw new Error(`Unexpected Agent mutation ${String(p.action)}`);
    },
  } as unknown as DB;
  const options: NativeAgentServiceOptions = {
    assertAccess: async () => undefined, headers: context.headers, streamDurationMs: 0, nativePlanning: { maxCredits: "10" },
    planningRead: async () => ({ nativeActions: [], nativePlanningTurns: [] }),
    planningPrepare: async (user, _db, turn, maxCredits) => { capturedTurn = copy(obj(turn)); return prepareNativeAgentPlanningAction(user, f.db, turn, maxCredits, f.options); },
    nativeOperation: async (user, _db, method, path) => {
      assert.equal(user.id, A.id); assert.equal(method, "GET"); const route = path.join("/");
      if (route === "ai/models/chat") return { data: [{ nativeModelId: "pm_chat_fixture", priceReady: true, generationReady: true }] };
      if (route === "ai/draft-generation/pricing") return { data: { imageModels: [{ nativeModelId: "pm_image_fixture", displayName: "会员图片模型", generationReady: true, capabilities: { images: true } }], videoModels: [] } };
      if (route === "v2/channels/accounts") return { data: { list: [{ id: accountId, nickname: "当前会员频道", type: "xhs", nativeRevision: 2 }] } };
      if (route === `material/group/info/${collectionId}`) return { data: { name: "会员集合", desc: "本次选定集合", nativeRevision: 2 } };
      if (route === `material/info/${draftId}`) return { data: { title: "会员原稿", desc: "只属于当前会员的素材文字", nativeRevision: 4, nativeMetadataRevision: 2 } };
      if (route === `assets/${assetId}`) return { data: { fileName: "owner-source.png", mime: "image/png", state: "ready", revision: 1 } };
      throw new Error(`Unexpected native read ${route}`);
    },
    mainHandler: async () => { throw new Error("No model call authorized by this test"); },
  };
  const prompt = "请先规划，需要我逐项确认";
  const result = await startNativeAgentTurn(A, agentDb, { requestKey: "fixture-real-planner-wire", taskId: task.id, expectedRevision: 10, modelId: "pm_chat_fixture", prompt, context: { accountIds: [accountId], collectionIds: [collectionId], draftIds: [draftId], assetIds: [assetId] } }, context.origin, context.cookies, options);
  await result.response?.text(); assert.equal(result.continuation, undefined); assert.ok(capturedTurn);
  const wire = obj(obj(capturedTurn.policy_snapshot).mainRequest), messages = wire.messages as { role: string; content: string }[];
  assert.equal(messages[0].role, "system"); assert.ok(messages[0].content.startsWith("NATIVE_OPERATOR_PLAN_V1\n"));
  const filtered = clientChatHistory(messages); assert.equal(filtered.some(message => message.role === "system"), false);
  assert.equal(filtered.at(-1)?.content, prompt); assert.equal(filtered.at(-2)?.role, "user");
  for (const rounds of [0, 1, 8]) {
    const prepared = await prepareContext(filtered, { maxContextRounds: rounds, maxContextTokens: 32768 });
    const visible = JSON.stringify(prepared); assert.ok(visible.includes("generate_image")); assert.ok(visible.includes("pm_image_fixture")); assert.ok(visible.includes(draftId)); assert.ok(visible.includes(accountId)); assert.ok(visible.includes(assetId));
    assert.equal(prepared.at(-1)?.content, prompt);
  }
  const parameters = { agentDeepThinkingType: 0, agentDeductDeepThink: 1, agentMaxContextRounds: 1, agentMaxContextTokens: 32768, agentMaxReplyTokens: 4096, agentTimeout: 120, agentEnableWebSearch: false, agentTemperature: undefined, agentResponseFormat: undefined };
  const composed = await composeLlmRequestMessages({ ...parameters, agentId: "__free_chat__", agentName: "", agentRow: null, mangaSkillOrchestration: null, isCanvasInternalWorkflow: false, verifiedUserId: A.id, body: wire, globalPrefix: "", messages, useModel: model.model_name, loadProfileContext: async () => "", loadSkills: async () => null });
  const chatRequest = buildLlmChatRequest(model.model_name, composed.finalMessages as ChatMessage[], parameters, true);
  const actual = JSON.stringify(chatRequest.messages);
  for (const expected of ["generate_image", "propose_publish", "pm_image_fixture", draftId, accountId, collectionId, assetId, "只属于当前会员的素材文字"]) assert.ok(actual.includes(expected), `missing final provider content: ${expected}`);
  assert.equal(chatRequest.messages.at(-1)?.content, prompt); assert.equal(composed.skillInjection, null);
  const actualQuote = quoteLlmStreamReservation(chatRequest, billing.config, 1); assert.ok(actualQuote);
  const planner = [...f.records.values()][0]; assert.ok(Number(planner.action.quote.quotedAmount) >= actualQuote.amount); assert.ok(Number(planner.action.quote.maxAmount) >= actualQuote.amount);
  assert.equal(f.invoked.length, 0); assert.equal(f.localCalls.length, 0);
});
