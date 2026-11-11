import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { NativeAiActionDtoSchema, NativeAiBatchSnapshotSchema, type NativeAiActionDto, type NativeAiBatchResult } from "../src/lib/native-ai-contract";

const rootRequire = createRequire(import.meta.url);
const childRoot = path.resolve("integrations/aitoearn-native-app");
const childRequire = createRequire(path.join(childRoot, "package.json"));
const loaded = new Map<string, unknown>();
function load(name: string): ReturnType<typeof childRequire> {
  const filename = path.join(childRoot, "src/integration", name);
  if (loaded.has(filename)) return loaded.get(filename);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  const resolve = (request: string): unknown => {
    if (request === "./host-session") return { subscribeHostSession: () => () => {}, assertHostSession: () => ({ user: { id: "owner-a" } }), getHostSessionRevision: () => 1, hostStorageKey: (key: string) => `owner-a:${key}` };
    if (request === "./host-transport") return { nativeBffFetch: () => { throw new Error("network prohibited in fixture"); } };
    if (request.startsWith("@host-publishing/")) return rootRequire(`../src/lib/${request.slice("@host-publishing/".length)}.ts`);
    if (request === "@/components/ui/button") return { Button: "button" };
    if (request === "@/utils/ui/confirm") return { confirm: () => { throw new Error("confirmation is not invoked during static rendering"); } };
    if (request === "./NativeAiPublishHandoff") return { NativeAiPublishHandoff: () => null };
    if (request.startsWith("./")) return load(request.slice(2) + (request.includes("Panel") ? ".tsx" : ".ts"));
    return childRequire(request);
  };
  new Function("require", "module", "exports", output)(resolve, target, target.exports);
  loaded.set(filename, target.exports);
  return target.exports;
}
const clientModule = load("native-ai-client.ts");
const protocol = load("native-agent-protocol.ts");
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const ids = { action: "10000000-0000-4000-8000-000000000001", batch: "10000000-0000-4000-8000-000000000002", item: "10000000-0000-4000-8000-000000000003", collection: "10000000-0000-4000-8000-000000000004", task: "10000000-0000-4000-8000-000000000005", turn: "10000000-0000-4000-8000-000000000006" };
const stamp = "2026-11-10T00:00:00.000Z";
const snapshot = NativeAiBatchSnapshotSchema.parse({ version: "native-ai-batch.v1", mode: "image_text", collectionId: ids.collection, prompt: "会员明确选择的内容", captionPrompt: "", quantity: 1, imageCount: 1, plannerModelId: "pm_planner", generationModelId: "pm_image", options: { aspectRatio: "1:1", resolution: "1K", duration: null }, platforms: [], budget: { credits: "2", CNY: "10" }, savePolicy: "confirm_resolved_drafts" });
function action(extra: Partial<NativeAiActionDto> = {}): NativeAiActionDto {
  return NativeAiActionDtoSchema.parse({ id: ids.action, scope: { kind: "batch", batchId: ids.batch, itemId: ids.item }, revision: 1, state: "proposed", kind: "plan_text", actionHash: "a".repeat(64), args: { prompt: "SERVER_INTERNAL_PLAN_JSON" }, quote: { unit: "credits", quotedAmount: "0.2", maxAmount: "2", priceHash: "b".repeat(64), expiresAt: stamp }, slots: [{ slot: 0, requestKey: `native_${ids.action}_0`, consumer: "main_llm", state: "proposed", dispatchId: null, receipt: null }], createdAt: stamp, updatedAt: stamp, ...extra });
}
function batch(actions: NativeAiActionDto[] = [action()]): NativeAiBatchResult {
  return { batch: { id: ids.batch, revision: 1, state: actions.every(item => item.state === "succeeded") ? "succeeded" : "proposed", mode: "image_text", quantity: 1, manifestHash: "c".repeat(64), snapshot, createdAt: stamp, updatedAt: stamp }, items: [{ id: ids.item, batchId: ids.batch, ordinal: 0, revision: 1, state: "proposed", rootActionId: ids.action, actionIds: actions.map(item => item.id), createdAt: stamp, updatedAt: stamp }], actions };
}
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data, message: "" }), { headers: { "Content-Type": "application/json" } });
function harness(fetch: (resource: string, init?: RequestInit) => Promise<Response>) {
  const storage = new MemoryStorage(); let owner = "owner-a", revision = 1, sequence = 10;
  const client = clientModule.createNativeAiClient({ actor: () => ({ owner, revision }), assert: (expectedOwner: string, expectedRevision: number) => { if (owner !== expectedOwner || revision !== expectedRevision) throw new Error("owner changed"); }, storage: () => storage, storageKey: (key: string) => `${owner}:${key}`, fetch, randomId: () => `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`, changed() {} });
  return { client, storage, changeOwner() { owner = "owner-b"; revision++; } };
}

test("lost creation acknowledgement keeps owner marker and recovers only by exact GET key", async () => {
  const calls: { resource: string, method?: string }[] = []; let found = false;
  const h = harness(async (resource, init) => {
    calls.push({ resource, method: init?.method });
    if (init?.method === "POST") { assert.equal(h.client.pending().length, 1, "durable marker exists before POST"); throw new Error("lost acknowledgement"); }
    return ok(found ? batch() : null);
  });
  await assert.rejects(h.client.prepareBatch(snapshot), /lost acknowledgement/);
  const [marker] = h.client.pending(); assert(marker);
  await assert.rejects(h.client.prepareBatch(snapshot), /待核对/);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(await h.client.recover(marker), null);
  assert.equal(h.client.pending().length, 1, "a missing upstream record does not permit reposting");
  assert.equal(calls.at(-1)?.resource, `ai/batches?requestKey=${encodeURIComponent(marker.requestKey)}`);
  found = true; const recovered = await h.client.recover(marker);
  assert.equal(recovered.batch.id, ids.batch); assert.equal(h.client.pending().length, 0);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("approval body contains only immutable proposal identity, CAS, decision and stored key", async () => {
  let posted: Record<string, unknown> = {};
  const proposed = action(); const approved = action({ state: "approved", revision: 2 });
  const h = harness(async (_resource, init) => { posted = JSON.parse(String(init?.body)); assert.equal(h.client.pending()[0].requestKey, posted.requestKey); return ok({ action: approved }); });
  assert.equal((await h.client.decideAction(proposed, "approve")).state, "approved");
  assert.deepEqual(Object.keys(posted).sort(), ["decision", "expectedRevision", "proposalId", "requestKey"]);
  assert.equal(posted.proposalId, proposed.id); assert.equal(posted.expectedRevision, 1);
  assert.equal(h.client.pending().length, 0);
});

test("invalid acknowledgement and owner epoch change preserve recovery data without a second POST", async () => {
  const malformed = harness(async () => ok({ action: { state: "succeeded" } }));
  await assert.rejects(malformed.client.decideAction(action(), "approve"));
  assert.equal(malformed.client.pending().length, 1);
  const switched = harness(async () => { switched.changeOwner(); return ok({ action: action({ state: "approved" }) }); });
  await assert.rejects(switched.client.decideAction(action(), "approve"), /owner changed/);
  assert.equal(switched.client.pending().length, 0, "new owner never sees previous owner markers");
  assert.equal(JSON.parse(switched.storage.getItem("owner-a:ai-pending")!)[0].actionId, ids.action);
});

test("GET action recovery does not dispatch and planning recovery waits for a real persisted result", async () => {
  const calls: string[] = []; let ready = false;
  const h = harness(async (resource, init) => {
    calls.push(`${init?.method}:${resource}`);
    if (init?.method === "POST") throw new Error("lost acknowledgement");
    return ok({ id: ids.task, nativeActions: [], nativePlanningTurns: ready ? [{ turnId: ids.turn, actionId: ids.action, state: "succeeded", rawTextHash: "d".repeat(64), reply: "已解析回复", actionIds: [], blockedCandidates: [], parseError: "" }] : [] });
  });
  await assert.rejects(h.client.advancePlan(ids.task));
  const [marker] = h.client.pending(); assert.equal(await h.client.recover(marker), null); assert.equal(h.client.pending().length, 1);
  ready = true; assert.equal((await h.client.recover(marker)).id, ids.task); assert.equal(h.client.pending().length, 0);
  assert.equal(calls.filter(call => call.startsWith("POST:")).length, 1);
  assert(calls.slice(1).every(call => call === `GET:agent/tasks/${ids.task}`));
});

test("planner success is not workflow completion; only a real saved draft receipt completes an item", () => {
  const planned = action({ state: "succeeded" });
  assert.equal(clientModule.nativeAiBatchWorkflow(batch([planned])).workflowComplete, false);
  const saved = action({ id: "10000000-0000-4000-8000-000000000007", kind: "save_draft", state: "succeeded", slots: [{ slot: 0, requestKey: "native_save_0", consumer: "native_core", state: "succeeded", dispatchId: ids.action, receipt: { source: "native_core", id: "receipt", status: "succeeded", resultRefs: [{ kind: "draft", id: ids.collection }] } }] });
  const result = clientModule.nativeAiBatchWorkflow(batch([planned, saved]));
  assert.equal(result.workflowComplete, true); assert.equal(result.items[0].draftId, ids.collection);
});

test("rendered costs remain separate and planned raw JSON never appears as user conversation", () => {
  const React = childRequire("react"); const { renderToStaticMarkup } = childRequire("react-dom/server");
  const details = load("NativeAiActionPanel.tsx"); const panels = load("NativeAiBatchPanel.tsx");
  const credit = action({ quote: { ...action().quote, quotedAmount: "1.2", maxAmount: "2" } });
  const cash = action({ id: "10000000-0000-4000-8000-000000000007", kind: "generate_image", quote: { ...action().quote, unit: "CNY", quotedAmount: "3.45", maxAmount: "5" } });
  assert.deepEqual(panels.nativeAiQuotedTotals([credit, cash]), { credits: "1.2", CNY: "3.45" });
  const html = renderToStaticMarkup(React.createElement(details.NativeAiActionDetails, { action: credit }));
  assert.match(html, /1.2/); assert.match(html, /积分/); assert.doesNotMatch(html, /SERVER_INTERNAL_PLAN_JSON/);
  const planning = [{ turnId: ids.turn, actionId: ids.action, state: "succeeded", rawTextHash: "d".repeat(64), reply: "会员可读的解析回复", actionIds: [], blockedCandidates: [], parseError: "" }];
  const messages = protocol.nativeAgentHistory([{ turnId: ids.turn, type: "assistant", content: "RAW_PRIVATE_JSON" }, { turnId: ids.action, type: "assistant", content: "普通旧历史" }], planning);
  assert.deepEqual(messages.map((message: { content: string }) => message.content), ["会员可读的解析回复", "普通旧历史"]);
  const stream = protocol.reduceNativeAgentTranscript(protocol.createNativeAgentTranscript([], "用户内容", "fixture-key", true), { type: "assistant", content: "RAW_PRIVATE_JSON" });
  assert(!protocol.nativeAgentTranscriptMessages(stream).some((message: { content: string }) => message.content.includes("RAW_PRIVATE_JSON")));
  assert.equal(stream.text, "RAW_PRIVATE_JSON", "raw stream remains internal evidence rather than visible text");
  const status = renderToStaticMarkup(React.createElement(panels.NativeAiBatchStatus, { result: clientModule.nativeAiBatchWorkflow(batch([action({ state: "succeeded" })])) }));
  assert.match(status, /0\/1/); assert.doesNotMatch(status, /<h3[^>]*>完整草稿已保存/);
});

test("the original batch submit path blocks unsupported references and opens staged review for ready token-priced models", async () => {
  const source = path.join(childRoot, "src/components/draft-box/components/AiBatchGenerateBar/hooks/useAiBatchSubmitHandler.ts");
  const warnings: string[] = []; const confirmations: { content: { props: { drafts: { generationModelId: string }[] } } }[] = [];
  const output = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const target = { exports: {} as { useAiBatchSubmitHandler: (value: Record<string, unknown>) => () => Promise<void> } };
  const resolve = (request: string) => {
    if (request === "react") return { ...childRequire("react"), useCallback: (callback: unknown) => callback };
    if (request === "@/hooks/useDraftGenerationPricing") return { useDraftGenerationPricing: () => ({ pricingData: { imageModels: [], videoModels: [{ name: "visible-token-model", nativeModelId: "pm_token_video", generationReady: true, priceReady: true, nativeBilling: { unit: "per_token", price: null }, defaults: { resolution: "720p" } }] } }) };
    if (request === "@/utils/ui/confirm") return { confirm: (value: typeof confirmations[number]) => { confirmations.push(value); return Promise.resolve(false); } };
    if (request === "@/utils/ui/toast") return { toast: { warning: (message: string) => warnings.push(message) } };
    if (request === "@/integration/NativeAiBatchPanel") return { NativeAiBatchPanel: "fixture-batch-panel" };
    if (request === "@host-publishing/native-operations-contract") return rootRequire("../src/lib/native-operations-contract.ts");
    throw new Error(`unexpected dependency: ${request}`);
  };
  new Function("require", "module", "exports", output)(resolve, target, target.exports);
  const params = { isUploading: false, promptValue: "用户内容", groupId: ids.collection, effectiveQuantity: 1, localImages: [{}], localVideos: [], localAudios: [], effectiveSelectedPlatforms: [], contentType: "video", selectedVideoModels: ["visible-token-model"], resolvedVideoModelParams: {}, duration: 5, aspectRatio: "16:9", isDraftMode: false, t: (key: string) => key };
  await target.exports.useAiBatchSubmitHandler(params)();
  assert.match(warnings[0], /参考素材尚未纳入计划/); assert.equal(confirmations.length, 0);
  await target.exports.useAiBatchSubmitHandler({ ...params, localImages: [] })();
  assert.equal(confirmations.length, 1); assert.equal(confirmations[0].content.props.drafts[0].generationModelId, "pm_token_video");
});
