import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { z } from "zod";
import * as contracts from "../src/lib/native-agent-contract";
import * as aiContracts from "../src/lib/native-ai-contract";
import * as assetContracts from "../src/lib/publishing-v3-contract";

const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", assetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const approval = { revision: 3, configHash: "a".repeat(64), maxCreditsPerTurn: "50.000000" };
const runtime = { ready: true, message: "助手已就绪", budget: { maxCreditsPerTurn: approval.maxCreditsPerTurn, maxCallsPerTurn: 8 },
  approval, capabilities: { readDraft: true, saveDraft: true, media: false, publish: false } };
const input = () => ({ requestKey: "native-agent:" + randomUUID(), prompt: "改写已有草稿", runtimeApproval: { ...approval } });
const root = process.cwd(), sourceRoot = path.join(root, "integrations/aitoearn-native-app/src");
type Bag = Record<string, unknown>;
type Runtime = typeof runtime;
type Context = contracts.NativeAgentMemberStart["context"];
interface ComposerState { runtime: Runtime | null; context: Context; loading: boolean; issue: string; load(): Promise<void>; setContext(value: Context): void }
interface ComposerModule { useNativeAgentComposer: { getState(): ComposerState; setState(value: Partial<ComposerState>): void }; nativeAgentMemberRuntime(): Runtime; NativeAgentMemberRuntimeSchema: z.ZodType }
interface StreamCallbacks { afterSeq?: number; expectedTaskId?: string; onTaskId(id: string): void; onEvent(event: Bag): void; onUnknown(message: string): void }
interface ClientModule {
  submitNativeAgentTurn(raw: unknown, callbacks: StreamCallbacks): Promise<{ acknowledged: Promise<string>; completion: Promise<void>; abort(): void }>;
  readNativeAgentPending(): { requestKey: string; taskId?: string } | null;
  recoverNativeAgentPending(): Promise<{ found: boolean; task: Bag | null } | null>;
}
interface Params { prompt: string; expectedRevision?: number; nativeStatus?: string; nativeLastSeq?: number; taskId?: string; medias?: Array<{ url: string; progress?: number }>; t(key: string): string }
interface Methods { createTask(params: Params): Promise<string | null>; continueTask(params: Params & { taskId: string }): Promise<void> }
interface ProtocolModule {
  createNativeAgentTranscript(base: unknown[], prompt: string, requestKey: string): Bag;
  reduceNativeAgentTranscript(current: Bag, event: Bag): Bag;
  nativeAgentTranscriptMessages(value: Bag): Bag[];
  nativeAgentHistory(messages: unknown[], planning: unknown[], events: unknown[]): Bag[];
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Every I/O dependency is explicit. An unknown import or actual fetch fails the verifier. */
function fixture() {
  let owner: string | null = actor, revision = 1, runtimeValue: unknown = plain(runtime), sequence = 0;
  let confirmResult: () => boolean | Promise<boolean> = () => true;
  let runtimeReply: (() => Promise<unknown>) | null = null;
  const listeners = new Set<() => void>(), storage = new Map<string, string>();
  const effects = { runtimeReads: 0, unexpectedNetwork: 0, confirmations: [] as Bag[], posts: [] as Bag[], gets: [] as string[], unknown: [] as string[] };
  const session = {
    assertHostSession(expectedOwner?: string, expectedRevision?: number) {
      if (!owner || expectedOwner && expectedOwner !== owner || expectedRevision !== undefined && expectedRevision !== revision) throw Error("主站登录身份已变化");
      return { user: { id: owner } };
    },
    getHostSession: () => owner ? { user: { id: owner } } : null,
    getHostSessionRevision: () => revision,
    hostStorageKey: (key: string) => owner ? `aitoearn-native.v1:${owner}:${key}` : null,
    subscribeHostSession(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    trackHostRequest() { return () => undefined; },
  };
  const task = () => ({ id: taskId, userId: owner, nativeRevision: 2, nativeStatus: "completed", messages: [] });
  let reply: (payload: Bag) => Promise<Response> = async () => {
    const events = [{ type: "init", taskId, turnId, seq: ++sequence, nativeStatus: "running" },
      { type: "assistant", taskId, turnId, seq: ++sequence, content: "草稿已保存" },
      { type: "done", taskId, turnId, seq: ++sequence, nativeStatus: "completed" }];
    return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const bff = async (url: string, options: RequestInit = {}) => {
    if (options.method === "POST") {
      assert.equal(url, "agent/tasks"); const body = JSON.parse(String(options.body)) as Bag; effects.posts.push(body); return reply(body);
    }
    effects.gets.push(url);
    const result = url.startsWith("agent/turns?") ? { taskId, turn: { id: turnId, taskId, state: "completed", revision: 2, createdAt: "now", updatedAt: "now" } } : task();
    return new Response(JSON.stringify({ code: 0, data: result, message: "" }), { headers: { "content-type": "application/json" } });
  };
  const http = { async get(url: string) {
    assert.equal(url, "agent/runtime"); effects.runtimeReads++;
    return { data: runtimeReply ? await runtimeReply() : plain(runtimeValue) };
  } };
  type StoreSetter = Bag | ((state: Bag) => Bag);
  const zustand = { create(creator: (set: (value: StoreSetter) => void, get: () => Bag) => Bag) {
    let state: Bag;
    const set = (value: StoreSetter) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
    const store = Object.assign((selector?: (value: Bag) => unknown) => selector ? selector(state) : state, { getState: () => state, setState: set });
    state = creator(set, () => state); return store;
  } };
  const cache = new Map<string, { exports: Bag }>();
  const load = (relative: string): Bag => {
    const filename = path.resolve(sourceRoot, relative), prior = cache.get(filename); if (prior) return prior.exports;
    const fixtureModule = { exports: {} as Bag }; cache.set(filename, fixtureModule);
    const dependencies: Bag = {
      zod: { z }, zustand, "@host-publishing/native-agent-contract": contracts,
      "@host-publishing/native-ai-contract": aiContracts, "@host-publishing/publishing-v3-contract": assetContracts,
      "@/utils/request": http,
      "@/integration/host-session": session, "./host-session": session,
      "./host-transport": { nativeBffFetch: bff },
      "./native-revisions": { observeNativeRevisions() {}, nativeExpectedRevisions() { return { expectedRevision: 2 }; } },
      "@/utils/ui/confirm": { async confirm(options: Bag) { effects.confirmations.push(plain(options)); return confirmResult(); } },
      "@/store/user": { useUserStore: { getState: () => ({ isAuthenticated: true, async fetchCreditsBalance() {} }) } },
      "@/utils/ui/toast": { toast: { info(message: string) { effects.unknown.push(message); }, error() {}, warning() {} } },
      "./agent.state": { getDefaultTaskData: () => ({ messages: [], nativeStatus: "idle" }), getInitialState: () => ({ taskMessages: {}, currentTaskId: "" }) },
    };
    const requireFixture = (specifier: string): unknown => {
      if (specifier in dependencies) return dependencies[specifier];
      if (specifier.startsWith("@/integration/")) return load(specifier.slice(2) + ".ts");
      if (specifier.startsWith(".")) return load(path.relative(sourceRoot, path.resolve(path.dirname(filename), specifier + ".ts")));
      throw Error("UNMOCKED_DEPENDENCY: " + specifier);
    };
    const compiled = transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    vm.runInNewContext(compiled, { module: fixtureModule, exports: fixtureModule.exports, require: requireFixture,
      localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
      crypto: { randomUUID }, structuredClone, URL, Response, Headers, AbortController, TextDecoder, TextEncoder, Error, setTimeout, clearTimeout,
      console: { warn() {}, error() {} }, fetch: () => { effects.unexpectedNetwork++; throw Error("NETWORK_FORBIDDEN"); },
    }, { filename });
    return fixtureModule.exports;
  };
  const composer = load("integration/native-agent-composer.ts") as unknown as ComposerModule;
  const client = load("integration/native-agent-client.ts") as unknown as ClientModule;
  const protocol = load("integration/native-agent-protocol.ts") as unknown as ProtocolModule;
  const methodsModule = load("store/agent/agent.methods.ts") as unknown as { createStoreMethods(context: Bag): Methods };
  let state: Bag = { taskMessages: {}, currentTaskId: "" };
  const methods = methodsModule.createStoreMethods({
    refs: { sseAbort: { value: null }, t: { value: null }, actionContext: { value: null } },
    set(value: StoreSetter) { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; }, get: () => state,
    messageUtils: { setMessages() {}, addMessage() {} }, resetRefs() {},
  });
  return { composer, client, protocol, methods, effects, storage, getState: () => state,
    setRuntime(value: unknown) { runtimeValue = value; }, setRuntimeReply(value: () => Promise<unknown>) { runtimeReply = value; },
    setConfirm(value: () => boolean | Promise<boolean>) { confirmResult = value; }, setReply(value: (payload: Bag) => Promise<Response>) { reply = value; },
    switchOwner(value: string | null) { owner = value; revision++; for (const listener of listeners) listener(); },
    setSequence(value: number) { sequence = value; },
  };
}
async function main() {
  const checks: string[] = [];
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); checks.push(name); };
  const callbacks = (): StreamCallbacks => ({ onTaskId() {}, onEvent() {}, onUnknown() {} });
  const params = (): Params => ({ prompt: "帮我改写草稿并保存新稿", t: key => key });
  const oldFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = async () => { network++; throw Error("REAL_NETWORK_FORBIDDEN"); };
  try {
    await check("new strict member DTO omits model and keeps old start/plan snapshots readable", () => {
      assert.equal(contracts.NativeAgentMemberStartSchema.safeParse(input()).success, true);
      const legacy = { requestKey: "legacy-key-1", prompt: "旧任务", modelId: "pm_fixture_model" };
      assert.equal(contracts.NativeAgentStartSchema.safeParse(legacy).success, true);
      assert.equal(contracts.NativeAgentPlanStartSchema.safeParse({ ...legacy, mode: "plan", maxCredits: "10" }).success, true);
      for (const extra of [{ modelId: legacy.modelId }, { mode: "plan" }, { maxCredits: "500" }, { apiKey: "fixture" }, { runtime: "external" }]) assert.equal(contracts.NativeAgentMemberStartSchema.safeParse({ ...input(), ...extra }).success, false);
    });
    await check("member continuation CAS and immutable runtime approval are both required", () => {
      assert.equal(contracts.NativeAgentMemberStartSchema.safeParse({ ...input(), taskId, expectedRevision: 2 }).success, true);
      for (const value of [{ ...input(), taskId }, { ...input(), expectedRevision: 2 }, { ...input(), taskId, expectedRevision: 0 },
        { ...input(), runtimeApproval: null }, { ...input(), runtimeApproval: { ...approval, configHash: "invalid" } },
        { ...input(), runtimeApproval: { ...approval, maxCreditsPerTurn: "0.000000" } }]) assert.equal(contracts.NativeAgentMemberStartSchema.safeParse(value).success, false);
    });
    await check("composer reads only backend runtime and accepts fixed decimal6 display budget", async () => {
      const f = fixture(); await f.composer.useNativeAgentComposer.getState().load();
      assert.deepEqual(plain(f.composer.nativeAgentMemberRuntime()), runtime); assert.equal(f.effects.runtimeReads, 1);
      assert.equal("modelId" in f.composer.useNativeAgentComposer.getState(), false); assert.equal("models" in f.composer.useNativeAgentComposer.getState(), false);
    });
    await check("not-ready/missing-schema/error runtime stays unavailable without catalog fallback", async () => {
      for (const value of [{ ...runtime, ready: false, approval: null, message: "管理员尚未配置助手" },
        { ...runtime, approval: null }, { ...runtime, approval: { ...approval, maxCreditsPerTurn: "60.000000" } }]) {
        const f = fixture(); f.setRuntime(value); await f.composer.useNativeAgentComposer.getState().load();
        assert.throws(() => f.composer.nativeAgentMemberRuntime()); await assert.rejects(() => f.methods.createTask(params()));
        assert.equal(f.effects.posts.length, 0); assert.equal(f.effects.confirmations.length, 0);
      }
      const f = fixture(); f.setRuntimeReply(async () => { throw Error("服务暂不可用（HTTP 503）"); });
      await f.composer.useNativeAgentComposer.getState().load(); assert.match(f.composer.useNativeAgentComposer.getState().issue, /503/u);
      assert.equal(f.composer.useNativeAgentComposer.getState().runtime, null);
    });
    await check("runtime request dedup and stale owner response cannot populate another session", async () => {
      const f = fixture(); let resolve!: (value: unknown) => void;
      f.setRuntimeReply(() => new Promise(done => { resolve = done; }));
      const a = f.composer.useNativeAgentComposer.getState().load(), b = f.composer.useNativeAgentComposer.getState().load();
      assert.equal(f.effects.runtimeReads, 1); f.switchOwner(null); resolve(runtime); await Promise.all([a, b]);
      assert.equal(f.composer.useNativeAgentComposer.getState().runtime, null); assert.deepEqual(plain(f.composer.useNativeAgentComposer.getState().context), { accountIds: [], collectionIds: [], draftIds: [], assetIds: [] });
    });
    await check("real member caller confirms backend budget once and posts only business input plus frozen approval", async () => {
      const f = fixture(); assert.equal(await f.methods.createTask(params()), taskId);
      assert.equal(f.effects.confirmations.length, 1); assert.match(String(f.effects.confirmations[0].content), /50\.000000/u);
      assert.deepEqual(plain(f.effects.posts[0].runtimeApproval), approval);
      assert.equal("modelId" in f.effects.posts[0], false); assert.equal("mode" in f.effects.posts[0], false); assert.equal("maxCredits" in f.effects.posts[0], false);
      assert.equal(f.effects.posts.length, 1);
    });
    await check("continue caller preserves task ID/revision and never continues unknown task", async () => {
      const f = fixture(); await assert.rejects(() => f.methods.continueTask({ ...params(), taskId, expectedRevision: 2, nativeLastSeq: 7, nativeStatus: "unknown" }));
      assert.equal(f.effects.runtimeReads, 0); f.setSequence(7);
      await f.methods.continueTask({ ...params(), taskId, expectedRevision: 2, nativeLastSeq: 7, nativeStatus: "completed" });
      assert.equal(f.effects.posts[0].taskId, taskId); assert.equal(f.effects.posts[0].expectedRevision, 2);
    });
    await check("cancelled expense confirmation retains input without submitting", async () => {
      const f = fixture(); f.setConfirm(() => false); await assert.rejects(() => f.methods.createTask(params()), /已保留/u);
      assert.equal(f.effects.posts.length, 0); assert.equal(f.client.readNativeAgentPending(), null);
    });
    await check("upload-incomplete and unsupported media reject before expense confirmation", async () => {
      for (const progress of [20, 100]) {
        const f = fixture(); await assert.rejects(() => f.methods.createTask({ ...params(), medias: [{ url: `/api/native-operations/assets/${assetId}/content`, progress }] }));
        assert.equal(f.effects.confirmations.length, 0); assert.equal(f.effects.posts.length, 0);
      }
    });
    await check("session/config changes during confirmation cannot submit an old approval", async () => {
      const f = fixture(); f.setConfirm(() => { f.switchOwner(null); return true; }); await assert.rejects(() => f.methods.createTask(params())); assert.equal(f.effects.posts.length, 0);
      const changed = fixture(); changed.setConfirm(() => { changed.composer.useNativeAgentComposer.setState({ runtime: { ...runtime, approval: { ...approval, revision: 4 } } }); return true; });
      await assert.rejects(() => changed.methods.createTask(params()), /状态已更新/u); assert.equal(changed.effects.posts.length, 0);
    });
    await check("pending task blocks caller/client; unknown response retains request and recovery performs GET only", async () => {
      const f = fixture(); f.setReply(async () => new Response("unavailable", { status: 503 }));
      const operation = await f.client.submitNativeAgentTurn(input(), callbacks()); await assert.rejects(operation.acknowledged); await operation.completion;
      assert.ok(f.client.readNativeAgentPending()); assert.equal(f.effects.posts.length, 1);
      await assert.rejects(() => f.methods.createTask(params()), /原任务/u); await assert.rejects(() => f.client.submitNativeAgentTurn(input(), callbacks()), /原任务/u);
      assert.equal(f.effects.posts.length, 1); assert.equal(f.effects.runtimeReads, 0);
      const recovered = await f.client.recoverNativeAgentPending(); assert.equal(recovered?.task?.id, taskId);
      assert.equal(f.effects.posts.length, 1); assert.equal(f.effects.gets.length, 2); assert.equal(f.client.readNativeAgentPending(), null);
    });
    await check("direct client rejects old model/plan keys before storage/network and does not invent action cards", async () => {
      const f = fixture(); await assert.rejects(() => f.client.submitNativeAgentTurn({ ...input(), modelId: "pm_fixture_model" }, callbacks()));
      assert.equal(f.effects.posts.length, 0); assert.equal(f.client.readNativeAgentPending(), null);
      const source = readFileSync(path.join(sourceRoot, "integration/native-agent-protocol.ts"), "utf8");
      assert.match(source, /actions: \[\], publishFlows: \[\]/u);
    });
    await check("persisted tool events project into original workflow steps with seq dedup and real draft receipt", () => {
      const f = fixture(), p = f.protocol;
      const event = (type: string, seq: number, data: Bag): Bag => ({ type, seq, turnId, taskId, data, createdAt: "2026-11-10T00:00:00Z" });
      let transcript = p.createNativeAgentTranscript([], "改写", "native-agent:test");
      transcript = p.reduceNativeAgentTranscript(transcript, event("native_tool_proposal", 1, { proposalId: "read-1", kind: "read_draft" }));
      transcript = p.reduceNativeAgentTranscript(transcript, event("native_tool_result", 2, { proposalId: "read-1", state: "succeeded", executionRef: {} }));
      const proposal = event("native_tool_proposal", 3, { proposalId: "save-1", kind: "save_draft" });
      transcript = p.reduceNativeAgentTranscript(transcript, proposal); transcript = p.reduceNativeAgentTranscript(transcript, proposal);
      transcript = p.reduceNativeAgentTranscript(transcript, event("native_tool_result", 4, { proposalId: "save-1", state: "succeeded", executionRef: { draftId: assetId, revision: 2 } }));
      const steps = plain(transcript.workflowSteps) as Bag[];
      assert.equal(steps.length, 2); assert.equal(steps[0].result, "已读取草稿"); assert.match(String(steps[1].result), new RegExp(assetId)); assert.match(String(steps[1].result), /版本：2/u);
      const assistant = p.nativeAgentTranscriptMessages(transcript)[1]; assert.equal((assistant.steps as Bag[]).length, 1);
      assert.deepEqual(plain(assistant.actions), []); assert.deepEqual(plain(assistant.publishFlows), []);
    });
    await check("model text, orphan results and save receipts without a draft ID cannot claim saved work", () => {
      const f = fixture(), p = f.protocol;
      let transcript = p.createNativeAgentTranscript([], "改写", "native-agent:test");
      transcript = p.reduceNativeAgentTranscript(transcript, { type: "assistant", seq: 1, content: "已保存新草稿：fake-id" });
      assert.equal((transcript.workflowSteps as unknown[]).length, 0);
      transcript = p.reduceNativeAgentTranscript(transcript, { type: "native_tool_result", seq: 2, turnId, data: { proposalId: "orphan", state: "succeeded", executionRef: { draftId: assetId } } });
      assert.equal((transcript.workflowSteps as unknown[]).length, 0);
      transcript = p.reduceNativeAgentTranscript(transcript, { type: "native_tool_proposal", seq: 3, turnId, data: { proposalId: "save-1", kind: "save_draft" } });
      transcript = p.reduceNativeAgentTranscript(transcript, { type: "native_tool_result", seq: 4, turnId, data: { proposalId: "save-1", state: "succeeded", executionRef: {} } });
      assert.equal((transcript.workflowSteps as Bag[])[0].result, undefined); assert.match(String((transcript.workflowSteps as Bag[])[0].content), /待核对/u);
    });
    await check("history and live caller carry durable workflow steps through existing message consumers", async () => {
      const f = fixture();
      const events = [{ type: "native_tool_proposal", seq: 2, turnId, taskId, data: { proposalId: "save-1", kind: "save_draft" } },
        { type: "native_tool_result", seq: 3, turnId, taskId, data: { proposalId: "save-1", state: "succeeded", executionRef: { draftId: assetId, revision: 1 } } }];
      const history = f.protocol.nativeAgentHistory([{ type: "assistant", uuid: turnId, turnId, content: "新稿已完成" }], [], [...events].reverse());
      assert.equal((((history[0].steps as Bag[])[0].workflowSteps as Bag[])[0]).result, "已保存新草稿，草稿编号：" + assetId + "，版本：1");
      f.setReply(async () => new Response([{ type: "init", taskId, turnId, seq: 1, nativeStatus: "running" }, ...events,
        { type: "assistant", taskId, turnId, seq: 4, content: "新稿已完成" }, { type: "done", taskId, turnId, seq: 5, nativeStatus: "completed" }].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
      await f.methods.createTask(params());
      const task = (f.getState().taskMessages as Record<string, Bag>)[taskId]; assert.equal((task.workflowSteps as unknown[]).length, 1);
      assert.equal((((task.messages as Bag[])[1].steps as Bag[])[0].workflowSteps as unknown[]).length, 1);
      const hook = readFileSync(path.join(sourceRoot, "app/[lng]/chat/[taskId]/hooks/useChatState.ts"), "utf8");
      assert.equal((hook.match(/nativeAgentHistory\(value.messages, value.nativePlanningTurns, value.nativeWorkflowEvents\)/gu) || []).length, 3);
    });
    await check("member controls remove model/planning/generic associations while ordinary model consumers remain", () => {
      const ui = readFileSync(path.join(sourceRoot, "integration/NativeAgentComposerTools.tsx"), "utf8");
      assert.doesNotMatch(ui, /nativePlanningSettings|主站任务模型|请选择模型|关联本站资料|文案规划积分上限/u);
      assert.match(ui, /查看原任务/u); assert.match(ui, /图片和视频处理暂未开放/u); assert.match(ui, /自动发布暂未开放/u);
      const chat = readFileSync(path.join(sourceRoot, "components/Chat/ChatInput/index.tsx"), "utf8");
      assert.match(chat, /const canSend = runtimeReady && !hasPending && !disabled && !isUploading && !isGenerating/u);
      assert.match(chat, /if \(canSend\)/u);
      assert.match(readFileSync(path.join(sourceRoot, "api/ai/ai.api.ts"), "utf8"), /ai\/models\/chat\?scene=/u);
      assert.match(readFileSync(path.join(sourceRoot, "integration/native-ai-client.ts"), "utf8"), /ai\/models\/chat\?scene=web/u);
    });
    assert.equal(network, 0);
    console.log(JSON.stringify({ status: "passed", groups: checks.length, checks,
      effects: { realNetwork: network, databaseWrites: 0, paidCalls: 0 },
      limitations: ["UI browser acceptance requires current runningLatest build", "Server verifies approval revision/hash/budget before a new request executes"] }, null, 2));
  } finally { globalThis.fetch = oldFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
