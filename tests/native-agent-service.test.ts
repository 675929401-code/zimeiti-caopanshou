import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AuthUser, getSupabase } from "../src/lib/api-middleware";
import {
  executeNativeAgentOperation, executeNativeAgentReadTool, nativeAgentAttemptId,
  nativeAgentTaskDto, readNativeAgentEvents, startNativeAgentTurn,
  type NativeAgentServiceOptions,
} from "../src/lib/server/native-agent-service";

type Row = Record<string, unknown>;
type RpcArgs = { p_owner: string; p?: Row; [key: string]: unknown };
const A: AuthUser = { id: "owner-a", role: "user", email: "a@example.invalid" };
const B: AuthUser = { id: "owner-b", role: "user", email: "b@example.invalid" };
const origin = "http://127.0.0.1:5000";
const cookies = { get: () => undefined };
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const obj = (value: unknown) => value as Row;
function fixture() {
  const tables: Record<string, Row[]> = {
    pub_native_agent_tasks: [], pub_native_agent_turns: [], pub_native_agent_events: [], llm_request_attempts: [],
  };
  const actions: Row[] = [], reads: { table: string; filters: [string, unknown][] }[] = [];
  function event(owner: unknown, task: Row, turn: Row, kind: string, payload: Row, key: string = randomUUID()) {
    task.next_seq = Number(task.next_seq) + 1;
    tables.pub_native_agent_events.push({ id: randomUUID(), owner_id: owner, task_id: task.id, turn_id: turn.id, seq: task.next_seq, kind, safe_payload: payload, event_key: key, created_at: new Date().toISOString() });
  }
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [], excludes: [string, unknown][] = [];
      let lower = 0, upper = Infinity, after = -1, maximum = Infinity, descending = false;
      let ilike = "";
      const query = {
        select() { return query; },
        eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        gt(_key: string, value: number) { after = value; return query; },
        not(key: string, _op: string, value: unknown) { excludes.push([key, value]); return query; },
        ilike(_key: string, value: string) { ilike = value.slice(1, -1); return query; },
        order(key: string, options: { ascending: boolean }) { if (key !== "id") descending = !options.ascending; return query; },
        limit(value: number) { maximum = value; return query; },
        range(from: number, to: number) { lower = from; upper = to + 1; return query; },
        async maybeSingle() { return execute(true); },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      function execute(single: boolean) {
        reads.push({ table, filters: [...filters] });
        let values = (tables[table] ?? []).filter(item => filters.every(([key, value]) => item[key] === value) && excludes.every(([key, value]) => item[key] !== value) && (after < 0 || Number(item.seq) > after) && (!ilike || String(item.title).includes(ilike)));
        const count = values.length;
        if (table === "pub_native_agent_events") values = values.sort((a, b) => Number(a.seq) - Number(b.seq));
        else if (descending) values = [...values].reverse();
        values = values.slice(lower, Math.min(upper, lower + maximum));
        return { data: single ? values[0] ? { ...values[0] } : null : values.map(item => ({ ...item })), error: null, count };
      }
      return query;
    },
    async rpc(name: string, args: RpcArgs) {
      const p = args.p ?? {}, owner = args.p_owner;
      if (name === "reconcile_native_agent_main_atomic") {
        actions.push({ action: "reconcile-main", owner, turnId: args.p_turn_id, outcome: args.p_outcome });
        const turn = tables.pub_native_agent_turns.find(item => item.id === args.p_turn_id && item.owner_id === owner);
        const task = tables.pub_native_agent_tasks.find(item => item.id === turn?.task_id && item.owner_id === owner);
        const key = `native-agent:${String(turn?.id)}:llm:0`;
        const attempt = tables.llm_request_attempts.find(item => item.record_id === args.p_main_attempt_id && item.user_id === owner && item.client_request_id === key);
        if (!task || !turn || !attempt || args.p_main_attempt_id !== nativeAgentAttemptId(owner, key)) return { data: null, error: { message: "NATIVE_AGENT_MAIN_ATTEMPT_INVALID" } };
        const full = args.p_full_text, outcome = args.p_outcome;
        if (outcome === "completed" && (attempt.state !== "succeeded" || attempt.response_fingerprint !== args.p_response_fingerprint || sha(String(attempt.response_body)) !== args.p_response_fingerprint || typeof full !== "string" || !attempt.result_reference) || outcome === "failed" && (attempt.state !== "failed" || full !== null)) return { data: null, error: { message: "NATIVE_AGENT_MAIN_ATTEMPT_UNVERIFIED" } };
        if (["completed", "failed", "cancelled"].includes(String(turn.state))) {
          if (turn.state === outcome && turn.main_attempt_id === attempt.record_id && (outcome === "failed" || turn.response_text === full)) return { data: { reconciled: true, alreadyReconciled: true, turn: { ...turn } }, error: null };
          return { data: null, error: { message: "NATIVE_AGENT_TERMINAL_STATE" } };
        }
        if (!turn.lease_owner || !["running", "streaming", "unknown", "cancel_requested"].includes(String(turn.state))) return { data: null, error: { message: "NATIVE_AGENT_TERMINAL_STATE" } };
        if (outcome === "completed") {
          const prefix = String(turn.response_text);
          if (!(full as string).startsWith(prefix)) return { data: null, error: { message: "NATIVE_AGENT_STREAM_CONFLICT" } };
          if ((full as string).length > prefix.length) event(owner, task, turn, "text_delta", { text: (full as string).slice(prefix.length) }, `main-reconcile:${String(attempt.record_id)}:${prefix.length}`);
          turn.response_text = full;
        }
        turn.state = outcome; turn.main_attempt_id = attempt.record_id; turn.revision = Number(turn.revision) + 1;
        task.status = outcome; task.revision = Number(task.revision) + 1;
        event(owner, task, turn, "status", { state: outcome }, `main-reconcile:terminal:${String(attempt.record_id)}`);
        return { data: { reconciled: true, alreadyReconciled: false, turn: { ...turn }, task: { ...task } }, error: null };
      }
      actions.push({ ...p, owner });
      const turns = tables.pub_native_agent_turns, tasks = tables.pub_native_agent_tasks;
      if (p.action === "prepare-turn") {
        const input = obj(p.request), previous = turns.find(turn => turn.owner_id === owner && turn.request_key === p.requestKey);
        if (previous) return { data: { task: tasks.find(task => task.id === previous.task_id), turn: previous, alreadyPrepared: true }, error: null };
        let task = input.taskId ? tasks.find(item => item.id === input.taskId && item.owner_id === owner) : undefined;
        if (!task) { task = { id: randomUUID(), owner_id: owner, title: String(input.prompt).slice(0, 100), revision: 1, next_seq: 0, archived: false, status: "idle", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; tasks.push(task); }
        const turn: Row = { id: p.turnId, owner_id: owner, task_id: task.id, request_key: p.requestKey, main_request_key: `native-agent:${String(p.turnId)}:llm:0`, input_snapshot: p.request, policy_snapshot: p.policy, model_public_id: input.modelId, state: "prepared", response_text: "", revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        turns.push(turn); task.status = "running"; task.revision = Number(task.revision) + 1;
        event(owner, task, turn, "user_message", { text: input.prompt });
        return { data: { task: { ...task }, turn: { ...turn }, alreadyPrepared: false }, error: null };
      }
      const turn = turns.find(item => item.owner_id === owner && item.id === p.turnId);
      const task = tasks.find(item => item.owner_id === owner && item.id === (turn?.task_id ?? p.taskId));
      if (!task) return { data: null, error: { message: "NATIVE_AGENT_NOT_FOUND" } };
      if (p.action === "claim-turn" && turn) {
        if (turn.state !== "prepared") return { data: { turn: { ...turn }, shouldExecute: false }, error: null };
        turn.state = "running"; turn.lease_owner = p.runnerId; turn.lease_expires_at = new Date(Date.now() + 600000).toISOString();
        event(owner, task, turn, "turn_started", { state: "running", mainRequestKey: "internal-only" });
        return { data: { turn: { ...turn }, shouldExecute: true }, error: null };
      }
      if (p.action === "cancel-before-main" && turn) {
        const existing = tables.llm_request_attempts.some(attempt => attempt.user_id === owner && attempt.client_request_id === `native-agent:${String(turn.id)}:llm:0`);
        const cancelled = turn.lease_owner === p.runnerId && turn.state === "cancel_requested" && !existing;
        if (cancelled) { turn.state = "cancelled"; task.status = "cancelled"; event(owner, task, turn, "status", { state: "cancelled" }); }
        return { data: { task: { ...task }, turn: { ...turn }, cancelled }, error: null };
      }
      if (p.action === "append-text" && turn) {
        const previous = tables.pub_native_agent_events.find(item => item.turn_id === turn.id && item.event_key === p.eventKey);
        if (previous) return String(obj(previous.safe_payload).text) === String(p.text) ? { data: { turn: { ...turn }, alreadyRecorded: true }, error: null } : { data: null, error: { message: "NATIVE_AGENT_IDEMPOTENCY_CONFLICT" } };
        if (!["running", "streaming", "unknown", "cancel_requested"].includes(String(turn.state))) return { data: null, error: { message: "NATIVE_AGENT_TERMINAL_STATE" } };
        turn.response_text = String(turn.response_text) + String(p.text); if (!["cancel_requested", "unknown"].includes(String(turn.state))) turn.state = "streaming"; event(owner, task, turn, "text_delta", { text: p.text }, String(p.eventKey));
      }
      else if (p.action === "finish-turn" && turn) {
        if (["completed", "failed", "cancelled"].includes(String(turn.state))) return turn.state === p.state ? { data: { turn: { ...turn }, alreadyRecorded: true }, error: null } : { data: null, error: { message: "NATIVE_AGENT_TERMINAL_STATE" } };
        turn.state = p.state; task.status = p.state; event(owner, task, turn, "status", { state: p.state, errorCode: p.errorCode });
      }
      else if (p.action === "observe-unknown" && turn) { if (Date.parse(String(turn.lease_expires_at)) <= Date.now()) { turn.state = "unknown"; task.status = "unknown"; event(owner, task, turn, "status", { state: "unknown" }); } }
      else {
        if (p.expectedRevision !== task.revision) return { data: null, error: { message: "NATIVE_AGENT_REVISION_CONFLICT" } };
        if (p.action === "rename") task.title = p.title;
        if (p.action === "favorite") task.favorited_at = p.favorite ? new Date().toISOString() : null;
        if (p.action === "rate") { task.rating = p.rating; task.rating_comment = p.comment; }
        if (p.action === "archive") task.archived = p.archived;
        if (p.action === "abort") {
          const active = turns.find(item => item.owner_id === owner && item.task_id === task.id && ["prepared", "running", "streaming", "unknown", "cancel_requested"].includes(String(item.state)));
          if (active) { active.state = active.state === "prepared" ? "cancelled" : "cancel_requested"; task.status = active.state; }
        }
      }
      task.revision = Number(task.revision) + 1;
      return { data: { task: { ...task }, turn: turn ? { ...turn } : null }, error: null };
    },
  } as unknown as ReturnType<typeof getSupabase>;
  let catalogCalls = 0, handlerCalls = 0;
  const options: NativeAgentServiceOptions = {
    assertAccess: async () => undefined,
    planningRead: async () => ({ nativeActions: [], nativePlanningTurns: [] }),
    streamDurationMs: 0,
    headers: new Headers({ cookie: "fixture-session=owner-a", "x-untrusted": "do-not-forward" }),
    nativeOperation: async (_user, _db, method, path) => {
      assert.equal(method, "GET");
      if (path.join("/") === "ai/models/chat") { catalogCalls++; return { data: [{ nativeModelId: "pm_fixture", priceReady: true, generationReady: true }] }; }
      return { data: { list: [], total: 0 } };
    },
    mainHandler: async request => {
      handlerCalls++;
      const payload = obj(await request.json()), key = String(payload.client_request_id);
      assert.equal(new URL(request.url).pathname, "/api/llm");
      assert.equal(payload.agentId, "__free_chat__");
      assert.equal(payload.modelId, "pm_fixture");
      assert.equal(payload.model_overridden, true);
      assert.equal("quote_expectation" in payload, false);
      assert.equal("userId" in payload, false);
      assert.equal(request.headers.get("idempotency-key"), key);
      assert.equal(request.headers.get("cookie"), "fixture-session=owner-a");
      assert.equal(request.headers.get("x-untrusted"), null);
      assert.equal(request.signal.aborted, false);
      const raw = 'data: {"choices":[{"delta":{"content":"真实增量🙂"}}]}\n\ndata: {"billing_complete":true,"operation_id":"wallet-fixture","credits_charged":0.2}\n\ndata: [DONE]\n\n';
      const id = nativeAgentAttemptId(A.id, key);
      tables.llm_request_attempts.push({ record_id: id, user_id: A.id, client_request_id: key, state: "succeeded", http_status: 200, response_body: raw, response_fingerprint: sha(raw), result_reference: "persisted-result" });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { const bytes = new TextEncoder().encode(raw); controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  };
  const start = { requestKey: "fixture-request-0001", modelId: "pm_fixture", prompt: "为当前会员整理内容" };
  return { db, tables, actions, reads, options, start, counts: () => ({ catalogCalls, handlerCalls }) };
}

function mainEvidence(f: ReturnType<typeof fixture>, turn: Row, text = "失联后已持久化的真实增量🙂", overrides: Row = {}) {
  const key = `native-agent:${String(turn.id)}:llm:0`;
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"billing_complete":true,"operation_id":"wallet-recovery-fixture","credits_charged":0.2}\n\ndata: [DONE]\n\n`;
  const attempt: Row = { record_id: nativeAgentAttemptId(A.id, key), user_id: A.id, client_request_id: key, state: "succeeded", http_status: 200, response_body: raw, response_fingerprint: sha(raw), result_reference: "persisted-recovery-result", ...overrides };
  f.tables.llm_request_attempts.push(attempt);
  return attempt;
}
async function lostRunner() {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
  turn.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  const read = (suffix: string[] = []) => executeNativeAgentOperation(A, f.db, "GET", ["agent", "tasks", String(task.id), ...suffix], new URLSearchParams(), null, origin, cookies, f.options);
  await read();
  assert.equal(task.status, "unknown");
  return { f, task, turn, read };
}

for (const endpoint of [[], ["messages"], ["stream"]]) {
  test(`GET ${endpoint.join("/") || "detail"} recovers a lost runner from its own later settled main receipt without a new handler`, async () => {
    const { f, task, turn, read } = await lostRunner();
    const text = "失联后已持久化的真实增量🙂";
    mainEvidence(f, turn, text);
    const observed = await read(endpoint);
    await observed.response?.body?.cancel();
    assert.equal(task.status, "completed");
    assert.equal(turn.response_text, text);
    assert.equal(f.counts().handlerCalls, 0);
    assert.equal(f.actions.filter(action => action.action === "claim-turn").length, 1);
    assert.equal(f.actions.filter(action => action.action === "reconcile-main").length, 1);
    if (endpoint.length === 0) assert.equal((obj(observed.data).messages as Row[]).at(-1)?.content, text);
  });
}

test("two concurrent GET observers reconcile one persisted suffix and one terminal event across independent calls", async () => {
  const { f, task, turn, read } = await lostRunner();
  turn.response_text = "已保存前缀🙂";
  const text = "已保存前缀🙂以及尚未写入的后缀中文";
  mainEvidence(f, turn, text);
  await Promise.all([read(), read(["messages"])]);
  assert.equal(task.status, "completed");
  assert.equal(turn.response_text, text);
  const suffixEvents = f.tables.pub_native_agent_events.filter(event => event.kind === "text_delta");
  assert.equal(suffixEvents.length, 1);
  assert.equal(obj(suffixEvents[0].safe_payload).text, "以及尚未写入的后缀中文");
  const terminalEvents = f.tables.pub_native_agent_events.filter(event => event.kind === "status" && obj(event.safe_payload).state === "completed");
  assert.equal(terminalEvents.length, 1);
  const sequence = task.next_seq;
  await read(["messages"]);
  assert.equal(task.next_seq, sequence);
  assert.equal(f.counts().handlerCalls, 0);
});

for (const state of ["running", "failed_unknown", "reconciliation_required"]) {
  test(`GET recovery cannot turn a ${state} main attempt into an Agent terminal`, async () => {
    const { f, task, turn, read } = await lostRunner();
    mainEvidence(f, turn, "not delivered", { state });
    await read();
    assert.equal(task.status, "unknown");
    assert.equal(turn.response_text, "");
    assert.equal(f.actions.some(action => action.action === "reconcile-main"), false);
    assert.equal(f.counts().handlerCalls, 0);
  });
}

test("fake or contradictory billing, nonterminal DONE, bad fingerprints, missing result references and conflicting prefixes stay unknown", async () => {
  for (const malformed of ["billing-text", "fingerprint", "result-reference", "prefix", "duplicate-billing", "duplicate-done", "billing-after-done", "text-after-done"]) {
    const { f, task, turn, read } = await lostRunner();
    const attempt = mainEvidence(f, turn, "authoritative result");
    if (malformed === "billing-text") {
      const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: 'billing_complete:true operation_id:fake [DONE]' } }] })}\n\ndata: [DONE]\n\n`;
      Object.assign(attempt, { response_body: raw, response_fingerprint: sha(raw) });
    } else if (malformed === "fingerprint") attempt.response_fingerprint = "a".repeat(64);
    else if (malformed === "result-reference") attempt.result_reference = "";
    else if (malformed === "prefix") turn.response_text = "a conflicting durable prefix";
    else {
      const billing = 'data: {"billing_complete":true,"operation_id":"contradictory-receipt","credits_charged":999}\n\n';
      const raw = String(attempt.response_body);
      const changed = malformed === "duplicate-billing" ? raw.replace("data: [DONE]", `${billing}data: [DONE]`)
        : malformed === "duplicate-done" ? `${raw}data: [DONE]\n\n`
        : malformed === "billing-after-done" ? `${raw}${billing}`
        : `${raw}data: {"choices":[{"delta":{"content":"late text"}}]}\n\n`;
      Object.assign(attempt, { response_body: changed, response_fingerprint: sha(changed) });
    }
    await read(["messages"]);
    assert.equal(task.status, "unknown", malformed);
    assert.equal(f.actions.some(action => action.action === "reconcile-main"), false, malformed);
    assert.equal(f.counts().handlerCalls, 0);
  }
});

test("foreign main receipts, changed stable keys and absent original leases cannot reconcile a task", async () => {
  for (const mismatch of ["foreign", "main-key", "lease", "prepared"]) {
    const { f, task, turn, read } = await lostRunner();
    const attempt = mainEvidence(f, turn);
    if (mismatch === "foreign") { attempt.user_id = B.id; attempt.record_id = nativeAgentAttemptId(B.id, String(attempt.client_request_id)); }
    else if (mismatch === "main-key") turn.main_request_key = `native-agent:${String(turn.id)}:llm:1`;
    else if (mismatch === "lease") turn.lease_owner = null;
    else turn.state = "prepared";
    await read();
    assert.equal(task.status, "unknown", mismatch);
    assert.equal(f.actions.some(action => action.action === "reconcile-main"), false, mismatch);
    assert.equal(f.counts().handlerCalls, 0);
  }
});

test("missing or NOWAIT-busy reconciliation preserves existing facts and never falls back to a model request", async () => {
  for (const errorCode of ["PGRST202", "55P03"]) {
    const { f, task, turn, read } = await lostRunner();
    mainEvidence(f, turn);
    const transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
    const original = transport.rpc.bind(transport);
    transport.rpc = async (name, args) => name === "reconcile_native_agent_main_atomic" ? { data: null, error: { code: errorCode, message: "fixture forward RPC unavailable or main row locked" } } : original(name, args);
    await read();
    assert.equal(task.status, "unknown");
    assert.equal(turn.response_text, "");
    assert.equal(f.counts().handlerCalls, 0);
  }
});

test("owner-only request-key lookup recovers an unacknowledged task identity without exposing snapshots or dispatching", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const before = f.actions.length;
  const lookup = (user: AuthUser, requestKey = f.start.requestKey) => executeNativeAgentOperation(user, f.db, "GET", ["agent", "turns"], new URLSearchParams({ requestKey }), null, origin, cookies, f.options);
  const found = obj((await lookup(A)).data);
  assert.equal(found.taskId, f.tables.pub_native_agent_tasks[0].id);
  assert.equal(obj(found.turn).state, "running");
  for (const forbidden of ["lease_owner", "policy_snapshot", "input_snapshot", f.start.prompt, "owner-a"]) assert.equal(JSON.stringify(found).includes(forbidden), false);
  assert.equal((await lookup(B)).data, null);
  assert.equal((await lookup(A, "fixture-request-never-seen")).data, null);
  assert.equal(f.actions.length, before);
  assert.equal(f.counts().handlerCalls, 0);
  await assert.rejects(executeNativeAgentOperation(A, f.db, "GET", ["agent", "turns"], new URLSearchParams({ requestKey: f.start.requestKey, owner: B.id }), null, origin, cookies, f.options), { code: "NATIVE_AGENT_INPUT_INVALID" });
});

test("looking up a committed prepared turn never takes its still-available execution claim", async () => {
  const f = fixture(), transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
  const original = transport.rpc.bind(transport);
  transport.rpc = async (name, args) => args.p?.action === "claim-turn" ? { data: null, error: { message: "fixture crash before claim" } } : original(name, args);
  await assert.rejects(startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options));
  transport.rpc = original;
  const before = f.actions.length;
  const found = await executeNativeAgentOperation(A, f.db, "GET", ["agent", "turns"], new URLSearchParams({ requestKey: f.start.requestKey }), null, origin, cookies, f.options);
  assert.equal(obj(obj(found.data).turn).state, "prepared");
  assert.equal(f.actions.length, before);
  assert.equal(f.counts().handlerCalls, 0);
});

test("a definitive failed main receipt may close an unknown turn while retaining its partial text", async () => {
  const { f, task, turn, read } = await lostRunner();
  turn.response_text = "原部分输出";
  mainEvidence(f, turn, "", { state: "failed", result_reference: null });
  await read(["messages"]);
  assert.equal(task.status, "failed");
  assert.equal(turn.response_text, "原部分输出");
  assert.equal(f.counts().handlerCalls, 0);
});

test("an observer can finish before a late normal-runner append or error without duplicate text or reversed success", async () => {
  for (const tail of ["append", "error"]) {
    const f = fixture();
    let firstPersisted!: () => void, release!: () => void;
    const onFirstPersisted = new Promise<void>(resolve => { firstPersisted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
    const original = transport.rpc.bind(transport);
    transport.rpc = async (name, args) => { const value = await original(name, args); if (args.p?.action === "append-text") firstPersisted(); return value; };
    let calls = 0;
    const options: NativeAgentServiceOptions = { ...f.options, mainHandler: async () => {
      calls++;
      const turn = f.tables.pub_native_agent_turns[0];
      mainEvidence(f, turn, "已存前缀和最终后缀🙂");
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已存前缀"}}]}\n\n'));
        await gate;
        if (tail === "error") controller.error(new Error("fixture late stream error"));
        else { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"和最终后缀🙂"}}]}\n\ndata: [DONE]\n\n')); controller.close(); }
      } }), { headers: { "content-type": "text/event-stream" } });
    } };
    const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
    await result.response?.body?.cancel();
    const work = result.continuation!();
    await onFirstPersisted;
    const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
    await executeNativeAgentOperation(A, f.db, "GET", ["agent", "tasks", String(task.id), "messages"], new URLSearchParams(), null, origin, cookies, options);
    assert.equal(task.status, "completed");
    release();
    await work;
    assert.equal(calls, 1);
    assert.equal(turn.response_text, "已存前缀和最终后缀🙂");
    assert.equal(task.status, "completed");
    assert.equal(f.tables.pub_native_agent_events.filter(event => event.kind === "status" && obj(event.safe_payload).state === "completed").length, 1);
  }
});

test("durable prepare/claim precede one fixed main handler call; replay and duplicate continuation never redispatch", async () => {
  const f = fixture();
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  assert.equal(f.counts().handlerCalls, 0);
  assert.deepEqual(f.actions.map(action => action.action), ["prepare-turn", "claim-turn"]);
  assert.ok(result.continuation);
  await result.response?.body?.cancel();
  // A later browser login must not replace the immutable actor headers of A's turn.
  f.options.headers?.set("cookie", "fixture-session=owner-b");
  await Promise.all([result.continuation(), result.continuation()]);
  assert.equal(f.counts().handlerCalls, 1);
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "completed");
  assert.equal(f.tables.pub_native_agent_turns[0].response_text, "真实增量🙂");
  const replay = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  assert.equal(replay.continuation, undefined);
  await replay.response?.body?.cancel();
  assert.equal(f.counts().handlerCalls, 1);
  assert.equal(f.counts().catalogCalls, 1);
  const frozen = obj(f.tables.pub_native_agent_turns[0].policy_snapshot);
  assert.equal(frozen.billingMode, "main_actual_usage");
  assert.equal(obj(obj(frozen.mainRequest).messages instanceof Array ? (obj(frozen.mainRequest).messages as unknown[]).at(-1) : {}).content, f.start.prompt);
  for (const read of f.reads) assert.ok(read.filters.some(([key, value]) => (key === "owner_id" || key === "user_id") && value === A.id), `unscoped ${read.table}`);
});

test("an append committed before its response was lost is read back before any late supplementation", async () => {
  const f = fixture();
  const transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
  const original = transport.rpc.bind(transport);
  let lost = false;
  transport.rpc = async (name, args) => {
    const result = await original(name, args);
    if (!lost && args.p?.action === "append-text") { lost = true; return { data: null, error: { message: "fixture database response lost after commit" } }; }
    return result;
  };
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  await result.continuation?.();
  assert.equal(lost, true);
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "completed");
  assert.equal(f.tables.pub_native_agent_turns[0].response_text, "真实增量🙂");
  assert.equal(f.actions.filter(action => action.action === "append-text").length, 1);
  assert.equal(f.counts().handlerCalls, 1);
});

test("the route can start work while SSE remains open, then detach without cancelling the one main call", async () => {
  const f = fixture();
  let started!: () => void, release!: () => void;
  const onStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mainHandler = f.options.mainHandler!;
  const options: NativeAgentServiceOptions = { ...f.options, pollMs: 1, streamDurationMs: 1000, mainHandler: async request => { started(); await gate; return mainHandler(request); } };
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "running");
  // Match the route's after(work) contract; after(callback) would not start here.
  const work = result.continuation!();
  await onStarted;
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "running");
  await result.response?.body?.cancel();
  release();
  await work;
  assert.equal(f.counts().handlerCalls, 1);
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "completed");
});

for (const concurrentRecoveries of [1, 2]) {
  test(`prepare committed before a crash is recoverable with ${concurrentRecoveries} reader(s) and one atomic execution grant`, async () => {
    const f = fixture();
    const transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
    const original = transport.rpc.bind(transport);
    transport.rpc = async (name, args) => args.p?.action === "claim-turn" ? { data: null, error: { message: "fixture crash before claim commit" } } : original(name, args);
    await assert.rejects(startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options), { code: "NATIVE_AGENT_STORAGE_UNAVAILABLE" });
    assert.equal(f.tables.pub_native_agent_turns[0].state, "prepared");
    assert.equal(f.counts().handlerCalls, 0);
    transport.rpc = original;
    const recovered = await Promise.all(Array.from({ length: concurrentRecoveries }, () => startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options)));
    assert.equal(recovered.filter(result => result.continuation).length, 1);
    await Promise.all(recovered.map(result => result.response?.body?.cancel()));
    await Promise.all(recovered.map(result => result.continuation?.()));
    assert.equal(f.counts().handlerCalls, 1);
    assert.equal(f.tables.pub_native_agent_tasks[0].status, "completed");
    assert.equal(f.counts().catalogCalls, 1);
  });
}

test("stream and message reconnection converge an expired lease to unknown without a new claim or main call", async () => {
  for (const endpoint of ["stream", "messages"]) {
    const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
    await result.response?.body?.cancel();
    const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
    turn.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    const reconnected = await executeNativeAgentOperation(A, f.db, "GET", ["agent", "tasks", String(task.id), endpoint], new URLSearchParams(), null, origin, cookies, f.options);
    await reconnected.response?.body?.cancel();
    assert.equal(task.status, "unknown");
    assert.equal(f.counts().handlerCalls, 0);
    assert.equal(f.actions.filter(action => action.action === "claim-turn").length, 1);
    assert.equal(f.actions.filter(action => action.action === "observe-unknown").length, 1);
  }
});

test("abort after claim and before continuation cancels through the atomic no-main-attempt check without a model or wallet call", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
  await executeNativeAgentOperation(A, f.db, "POST", ["agent", "tasks", String(task.id), "abort"], new URLSearchParams(), { expectedRevision: task.revision }, origin, cookies, f.options);
  assert.equal(turn.state, "cancel_requested");
  await result.continuation?.();
  assert.equal(f.counts().handlerCalls, 0);
  assert.equal(turn.state, "cancelled");
  assert.equal(task.status, "cancelled");
  assert.equal(f.tables.llm_request_attempts.length, 0);
  assert.equal(f.actions.filter(action => action.action === "cancel-before-main").length, 1);
  assert.equal(f.actions.some(action => /wallet|refund|settle/u.test(String(action.action))), false);
});

test("a rejected pre-main cancellation grant cannot fall through to dispatch", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
  await executeNativeAgentOperation(A, f.db, "POST", ["agent", "tasks", String(task.id), "abort"], new URLSearchParams(), { expectedRevision: task.revision }, origin, cookies, f.options);
  const transport = f.db as unknown as { rpc(name: string, args: RpcArgs): Promise<{ data: unknown; error: unknown }> };
  const original = transport.rpc.bind(transport);
  transport.rpc = async (name, args) => args.p?.action === "cancel-before-main" ? { data: { cancelled: false }, error: null } : original(name, args);
  await result.continuation?.();
  assert.equal(f.counts().handlerCalls, 0);
  assert.equal(turn.state, "cancel_requested");
  assert.equal(task.status, "cancel_requested");
});

test("abort with an existing main attempt does not claim that external work stopped and does not post again", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
  const key = `native-agent:${String(turn.id)}:llm:0`;
  f.tables.llm_request_attempts.push({ record_id: nativeAgentAttemptId(A.id, key), user_id: A.id, client_request_id: key, state: "running" });
  await executeNativeAgentOperation(A, f.db, "POST", ["agent", "tasks", String(task.id), "abort"], new URLSearchParams(), { expectedRevision: task.revision }, origin, cookies, f.options);
  await result.continuation?.();
  assert.equal(f.counts().handlerCalls, 0);
  assert.equal(turn.state, "cancel_requested");
  assert.equal(task.status, "cancel_requested");
  assert.equal(f.actions.filter(action => action.action === "cancel-before-main").length, 0);
});

test("abort after the main handler has started stays requested until the real main receipt arrives", async () => {
  const f = fixture();
  let started!: () => void, release!: () => void, calls = 0;
  const onStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const options: NativeAgentServiceOptions = { ...f.options, mainHandler: async request => {
    calls++;
    const key = String(obj(await request.json()).client_request_id), attempt: Row = { record_id: nativeAgentAttemptId(A.id, key), user_id: A.id, client_request_id: key, state: "running" };
    f.tables.llm_request_attempts.push(attempt);
    started();
    await gate;
    const raw = 'data: {"choices":[{"delta":{"content":"主站实际结果"}}]}\n\ndata: {"billing_complete":true,"operation_id":"wallet-inflight","credits_charged":0.2}\n\ndata: [DONE]\n\n';
    Object.assign(attempt, { state: "succeeded", http_status: 200, response_body: raw, response_fingerprint: sha(raw), result_reference: "stored" });
    return new Response(raw, { headers: { "content-type": "text/event-stream" } });
  } };
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
  await result.response?.body?.cancel();
  const work = result.continuation!();
  await onStarted;
  const task = f.tables.pub_native_agent_tasks[0], turn = f.tables.pub_native_agent_turns[0];
  await executeNativeAgentOperation(A, f.db, "POST", ["agent", "tasks", String(task.id), "abort"], new URLSearchParams(), { expectedRevision: task.revision }, origin, cookies, options);
  assert.equal(calls, 1);
  assert.equal(turn.state, "cancel_requested");
  assert.equal(task.status, "cancel_requested");
  assert.equal(f.actions.some(action => action.action === "cancel-before-main"), false);
  release();
  await work;
  assert.equal(calls, 1);
  assert.equal(turn.state, "completed");
  assert.equal(task.status, "completed");
});

test("a real main failed state is retained without automatic retry or a second payment path", async () => {
  const f = fixture();
  let calls = 0;
  const options = { ...f.options, mainHandler: async (request: Request) => {
    calls++;
    const key = String(obj(await request.json()).client_request_id);
    f.tables.llm_request_attempts.push({ record_id: nativeAgentAttemptId(A.id, key), user_id: A.id, client_request_id: key, state: "failed" });
    return new Response('{"error":"provider detail must remain private","code":"SOME_PROVIDER_ERROR"}', { status: 422 });
  } };
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
  await result.response?.body?.cancel();
  await result.continuation?.();
  assert.equal(f.tables.pub_native_agent_tasks[0].status, "failed");
  const replay = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
  await replay.response?.body?.cancel();
  assert.equal(replay.continuation, undefined);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(f.tables.pub_native_agent_events).includes("provider detail"), false);
});

test("same key with changed input is a conflict and an unready catalog never dispatches", async () => {
  const f = fixture();
  const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  await assert.rejects(startNativeAgentTurn(A, f.db, { ...f.start, prompt: "changed" }, origin, cookies, f.options), { code: "NATIVE_AGENT_IDEMPOTENCY_CONFLICT" });
  const g = fixture();
  await assert.rejects(startNativeAgentTurn(A, g.db, g.start, origin, cookies, { ...g.options, nativeOperation: async () => ({ data: [{ nativeModelId: "pm_fixture", priceReady: false, generationReady: false }] }) }), { code: "NATIVE_AGENT_MODEL_NOT_READY" });
  assert.equal(g.actions.length, 0);
  assert.equal(g.counts().handlerCalls, 0);
});

for (const attemptState of ["running", "failed_unknown", "reconciliation_required", "succeeded_without_billing"] as const) {
  test(`HTTP 200 and DONE cannot complete ${attemptState} without durable settlement`, async () => {
    const f = fixture();
    const options: NativeAgentServiceOptions = { ...f.options, mainHandler: async request => {
      const body = obj(await request.json()), key = String(body.client_request_id), raw = 'data: {"choices":[{"delta":{"content":"尚待核对"}}]}\n\ndata: [DONE]\n\n';
      f.tables.llm_request_attempts.push({ record_id: nativeAgentAttemptId(A.id, key), user_id: A.id, client_request_id: key, state: attemptState === "succeeded_without_billing" ? "succeeded" : attemptState, http_status: 200, response_body: raw, response_fingerprint: sha(raw), result_reference: "stored" });
      return new Response(raw, { headers: { "content-type": "text/event-stream" } });
    } };
    const result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, options);
    await result.response?.body?.cancel();
    await result.continuation?.();
    assert.equal(f.tables.pub_native_agent_tasks[0].status, "unknown");
    assert.equal(f.actions.filter(action => action.action === "claim-turn").length, 1);
    assert.equal(f.actions.some(action => String(action.action).includes("refund")), false);
  });
}

test("cross-account reads, event cursors and CAS writes stay owner scoped; DTO excludes internals", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  await result.continuation?.();
  const task = f.tables.pub_native_agent_tasks[0], taskId = String(task.id);
  await assert.rejects(executeNativeAgentOperation(B, f.db, "GET", ["agent", "tasks", taskId], new URLSearchParams(), null, origin, cookies, f.options), { code: "NATIVE_AGENT_NOT_FOUND" });
  await assert.rejects(executeNativeAgentOperation(B, f.db, "POST", ["agent", "tasks", taskId, "abort"], new URLSearchParams(), { expectedRevision: task.revision }, origin, cookies, f.options), { code: "NATIVE_AGENT_NOT_FOUND" });
  const events = await readNativeAgentEvents(A, f.db, taskId, { afterSeq: 1 }, f.options);
  assert.ok(events.every(event => event.seq > 1));
  assert.equal(JSON.stringify(events).includes("mainRequestKey"), false);
  assert.equal(JSON.stringify(events).includes("errorCode"), false);
  const dto = nativeAgentTaskDto({ ...task, lease_owner: "secret", policy_snapshot: { apiKey: "secret" }, main_conversation_id: "internal" });
  assert.equal(JSON.stringify(dto).includes("secret"), false);
  await assert.rejects(executeNativeAgentOperation(A, f.db, "PATCH", ["agent", "tasks", taskId], new URLSearchParams(), { expectedRevision: 1, title: "stale" }, origin, cookies, f.options), { code: "NATIVE_AGENT_REVISION_CONFLICT" });
  await assert.rejects(executeNativeAgentOperation(A, f.db, "PATCH", ["agent", "tasks", taskId], new URLSearchParams(), { expectedRevision: task.revision, title: "wrong action", action: "abort" }, origin, cookies, f.options), { code: "NATIVE_AGENT_INPUT_INVALID" });
});

test("native mutation mappings retain CAS and never confuse abort with an actual stopped provider", async () => {
  const f = fixture(), result = await startNativeAgentTurn(A, f.db, f.start, origin, cookies, f.options);
  await result.response?.body?.cancel();
  const task = f.tables.pub_native_agent_tasks[0], path = ["agent", "tasks", String(task.id)];
  const call = (method: string, suffix: string[], body: Row) => executeNativeAgentOperation(A, f.db, method, [...path, ...suffix], new URLSearchParams(), { expectedRevision: task.revision, ...body }, origin, cookies, f.options);
  await call("PATCH", [], { title: "新标题" });
  assert.equal(task.title, "新标题");
  await call("POST", ["favorite"], {});
  assert.ok(task.favorited_at);
  await call("POST", ["rating"], { rating: 4, comment: "fixture" });
  assert.equal(task.rating, 4);
  await call("POST", ["abort"], {});
  assert.equal(task.status, "cancel_requested");
  assert.equal(f.counts().handlerCalls, 0);
});

test("read tool allowlist uses fixed native routes and reports unavailable analytics without invented data", async () => {
  const f = fixture(), calls: string[] = [];
  const options: NativeAgentServiceOptions = { ...f.options, nativeOperation: async (_user, _db, method, path) => { assert.equal(method, "GET"); calls.push(path.join("/")); return { data: { list: [{ id: "owned" }], total: 1 } }; } };
  const accounts = await executeNativeAgentReadTool(A, f.db, { kind: "list_accounts", args: {} }, origin, cookies, options);
  assert.equal(accounts.supported, true);
  assert.deepEqual(calls, ["v2/channels/accounts"]);
  const analytics = await executeNativeAgentReadTool(A, f.db, { kind: "read_analytics", args: { recordId: randomUUID(), source: "official" } }, origin, cookies, options);
  assert.equal(analytics.supported, false);
  assert.equal(analytics.data, null);
  await assert.rejects(executeNativeAgentReadTool(A, f.db, { kind: "http", args: { url: "https://example.invalid" } }, origin, cookies, options), { code: "NATIVE_AGENT_INPUT_INVALID" });
  await assert.rejects(executeNativeAgentReadTool(A, f.db, { kind: "generate_image", args: { modelId: "pm_fixture", prompt: "draw", resolution: "1024", aspectRatio: "1:1" } }, origin, cookies, options), { code: "NATIVE_AGENT_CONFIRMATION_REQUIRED" });
});
