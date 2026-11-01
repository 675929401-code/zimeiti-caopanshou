import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  advanceChatGenerationProgress, CHAT_STREAM_RESULT_UNKNOWN_MESSAGE, classifyChatStreamFailure,
  closeChatStreamReader, readChatStreamChunk,
} from "../src/contexts/chat-recovery-policy";
import { createChatStreamWatchdog } from "../src/lib/chat-stream-watchdog";
import { knownChatFailureMessage } from "../src/lib/chat-customer-failure";
import { fetchWithRetry, isAbortLikeError } from "../src/contexts/chat-utils";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";

const appSource = ts.createSourceFile("app-context.tsx", readFileSync("src/contexts/app-context.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function productionInitializer<T>(name: string, expectedInitializer?: string): T {
  const initializers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && (!expectedInitializer || node.initializer.getText(appSource) === expectedInitializer)) initializers.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(appSource);
  assert.ok(initializers.length > 0, `${name} must exist in production`);
  assert.ok(initializers.every(value => value.getText(appSource) === initializers[0].getText(appSource)), `${name} must use the same initializer in every stream path`);
  const compiled = ts.transpileModule(`(${initializers[0].getText(appSource)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("knownChatFailureMessage", "CHAT_STREAM_RESULT_UNKNOWN_MESSAGE", `return ${compiled}`)(knownChatFailureMessage, CHAT_STREAM_RESULT_UNKNOWN_MESSAGE) as T;
}
const customerStreamError = productionInitializer<(value: unknown) => string>("customerStreamError");
const automaticStopMessage = productionInitializer<string>("automaticStopMessage", "CHAT_STREAM_RESULT_UNKNOWN_MESSAGE");
const messageSource = ts.createSourceFile("message-item.tsx", readFileSync("src/components/chat/message-item.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function messageRetryState(failureDetail: string): { unknown: boolean; retry: boolean } {
  const expressions = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ["isOutcomeUnknown", "canRetrySafely"].includes(node.name.text)) expressions.set(node.name.text, node.initializer.getText(messageSource));
    ts.forEachChild(node, visit);
  };
  visit(messageSource);
  assert.equal(expressions.size, 2, "production message retry guards must exist");
  return new Function("failureDetail", "onRetry", `const isOutcomeUnknown = ${expressions.get("isOutcomeUnknown")}; return {unknown:isOutcomeUnknown,retry:${expressions.get("canRetrySafely")}};`)(failureDetail, () => {}) as { unknown: boolean; retry: boolean };
}

class FakeClock {
  now = 0;
  private nextId = 0;
  readonly scheduled = new Map<number, { due: number; callback: () => void }>();
  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = this.nextId++;
    this.scheduled.set(id, { due: this.now + milliseconds, callback });
    return id;
  };
  clearTimeout = (id: number): void => { this.scheduled.delete(id); };
  advanceTo(target: number): void {
    assert.ok(target >= this.now);
    while (true) {
      const next = [...this.scheduled.entries()].filter(([, item]) => item.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].due;
      this.scheduled.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

const flush = async (): Promise<void> => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const checks: string[] = [];
const check = (name: string, actual: unknown, expected: unknown = true): void => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
let nextConversationId = 0;
function harness(options: { agentId?: string; clock?: FakeClock; hangCancel?: boolean } = {}) {
  const clock = options.clock ?? new FakeClock();
  const controller = new AbortController();
  const conversationId = `stream-${nextConversationId++}`;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const state = {
    postCount: 0, cancelCount: 0, readCount: 0, progress: 0, progressAdvances: 0,
    text: "", reasoning: "", input: "original user input", done: false, finalized: false, userStopped: false, watchdogAborted: false,
    failure: null as ReturnType<typeof classifyChatStreamFailure> | null, message: "",
  };
  const submit = (): ReadableStream<Uint8Array> => {
    state.postCount++;
    return new ReadableStream<Uint8Array>({
      start(value) { source = value; },
      cancel() {
        state.cancelCount++;
        if (options.hangCancel) return new Promise<void>(() => {});
      },
    });
  };
  const reader = submit().getReader();
  const watchdog = createChatStreamWatchdog({
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onExpire: () => { state.watchdogAborted = true; },
  });
  watchdog.register(conversationId, controller, options.agentId ?? "ordinary-agent");
  const completion = (async () => {
    const decoder = new SseEventStreamDecoder();
    try {
      while (!state.done) {
        state.readCount++;
        const chunk = await readChatStreamChunk(reader, controller.signal, 310_000, clock);
        for (const event of chunk.done ? decoder.finish() : decoder.push(chunk.value)) {
          const raw = event.data.trim();
          if (raw === "[DONE]") { state.done = true; break; }
          const data = JSON.parse(raw);
          // An explicit server error already has a known terminal classification.
          if (data.error) {
            state.failure = "failed";
            state.message = customerStreamError(data);
            state.done = true;
            break;
          }
          if (data.type === "generation_progress") {
            const next = advanceChatGenerationProgress(state.progress, data.received_chars);
            if (next > state.progress) state.progressAdvances++;
            state.progress = next;
          }
          state.text += data.choices?.[0]?.delta?.content ?? "";
          state.reasoning += data.choices?.[0]?.delta?.reasoning_content ?? "";
        }
        if (chunk.done) {
          if (!state.done) {
            state.failure = "result_unknown";
            state.message = CHAT_STREAM_RESULT_UNKNOWN_MESSAGE;
          }
          break;
        }
      }
    } catch (error) {
      state.failure = classifyChatStreamFailure({
        sseStarted: true, userStopped: state.userStopped, watchdogAborted: state.watchdogAborted,
        signalAborted: controller.signal.aborted,
        abortLike: error instanceof Error && error.name === "AbortError",
      });
      state.message = state.failure === "result_unknown" ? CHAT_STREAM_RESULT_UNKNOWN_MESSAGE : "";
    } finally {
      watchdog.clear(conversationId, controller);
      closeChatStreamReader(reader, controller, state.failure !== null);
      state.finalized = true;
    }
  })();
  return {
    clock, controller, state, completion, watchdog,
    send: async (value: unknown): Promise<void> => {
      source.enqueue(new TextEncoder().encode(typeof value === "string" ? value : `data: ${JSON.stringify(value)}\n\n`));
      await flush();
    },
    advance: async (target: number): Promise<void> => { clock.advanceTo(target); await flush(); },
    stop: async (): Promise<void> => { state.userStopped = true; controller.abort(); await flush(); },
    eof: async (): Promise<void> => { source.close(); await flush(); },
    fail: async (): Promise<void> => { source.error(new TypeError("connection lost")); await flush(); },
  };
}

async function main(): Promise<void> {
  const firstReadClock = new FakeClock();
  const firstReadController = new AbortController();
  const firstReadStream = new ReadableStream<Uint8Array>({
    start(source) { source.enqueue(new TextEncoder().encode("first chunk")); },
  });
  const firstReader = firstReadStream.getReader();
  const firstChunk = await readChatStreamChunk(firstReader, firstReadController.signal, 310_000, firstReadClock);
  check("a completed read clears timer handle zero", [firstChunk.done, firstReadClock.scheduled.size], [false, 0]);
  closeChatStreamReader(firstReader, firstReadController, false);

  const cleanupController = new AbortController();
  const frozenFailure = classifyChatStreamFailure({ sseStarted: true, userStopped: false, watchdogAborted: false, signalAborted: false, abortLike: false });
  const throwingReader = { cancel: () => { throw new Error("synchronous cancel failure"); } } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  assert.doesNotThrow(() => closeChatStreamReader(throwingReader, cleanupController, true));
  checks.push("synchronous cancellation failure cannot escape cleanup");
  check("synchronous cancellation failure still aborts transport and preserves the frozen outcome", [cleanupController.signal.aborted, frozenFailure], [true, "result_unknown"]);

  const waiting = harness();
  for (let at = 5_000; at <= 65_000; at += 5_000) {
    await waiting.advance(at);
    await waiting.send(": heartbeat\n\n");
  }
  check("five-second heartbeats keep a stream waiting beyond sixty seconds", waiting.state.finalized, false);
  check("heartbeat bytes never fabricate generation progress", waiting.state.progressAdvances, 0);
  await waiting.send({ choices: [{ delta: { content: "delayed answer" } }] });
  await waiting.send("data: [DONE]\n\n");
  await waiting.completion;
  check("delayed text survives until DONE", waiting.state.text, "delayed answer");
  check("DONE is successful without waiting for transport EOF", waiting.state.failure, null);
  check("successful DONE clears every read and watchdog timer", waiting.clock.scheduled.size, 0);
  check("waiting and success submit exactly once", waiting.state.postCount, 1);

  const buffered = harness();
  for (const [at, received] of [[20_000, 10], [40_000, 30], [60_000, 60], [80_000, 90]]) {
    await buffered.advance(at);
    await buffered.send({ type: "generation_progress", received_chars: received });
  }
  for (const received of [90, 80, -1, "100", null]) {
    await buffered.send({ type: "generation_progress", received_chars: received });
  }
  check("buffered output advances only for strictly increasing numeric counts", buffered.state.progressAdvances, 4);
  check("invalid duplicate or falling progress cannot change cumulative count", buffered.state.progress, 90);
  for (const received of [NaN, Infinity, -Infinity, undefined, {}, true]) {
    check(`non-finite or non-numeric progress is ignored: ${String(received)}`, advanceChatGenerationProgress(90, received), 90);
  }
  await buffered.send({ choices: [{ delta: { content: "buffered answer" } }] });
  await buffered.send("data: [DONE]\n\n");
  await buffered.completion;
  check("buffered generation completes without resubmission", [buffered.state.failure, buffered.state.postCount], [null, 1]);

  const idle = harness({ agentId: STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, hangCancel: true });
  await idle.advance(309_999);
  check("a pending read survives before the 310-second byte deadline", idle.state.finalized, false);
  await idle.advance(310_000);
  await idle.completion;
  check("310 seconds without bytes yields an unknown result", idle.state.failure, "result_unknown");
  check("unknown idle result retains the shared no-resend explanation", idle.state.message, CHAT_STREAM_RESULT_UNKNOWN_MESSAGE);
  check("a hanging reader cancellation cannot block finalization", idle.state.finalized);
  check("a hanging cancellation is attempted once and its controller is already aborted", [idle.state.cancelCount, idle.controller.signal.aborted], [1, true]);
  check("idle failure aborts only its transport and removes timers", [idle.controller.signal.aborted, idle.clock.scheduled.size], [true, 0]);
  check("idle failure never submits again", idle.state.postCount, 1);

  for (const mode of ["network", "eof"] as const) {
    const interrupted = harness();
    await interrupted.send({ choices: [{ delta: { content: "preserved partial", reasoning_content: "preserved reasoning" } }] });
    if (mode === "network") await interrupted.fail(); else await interrupted.eof();
    await interrupted.completion;
    check(`${mode} without DONE preserves partial output and unknown outcome`,
      [interrupted.state.text, interrupted.state.failure, interrupted.state.message, interrupted.state.postCount],
      ["preserved partial", "result_unknown", CHAT_STREAM_RESULT_UNKNOWN_MESSAGE, 1]);
    check(`${mode} preserves reasoning and the original input`, [interrupted.state.reasoning, interrupted.state.input], ["preserved reasoning", "original user input"]);
  }

  const serverError = harness();
  await serverError.send({ error: "LLM_UPSTREAM_CONTENT_REJECTED" });
  await serverError.completion;
  check("known data.error uses the production customer error callback", [serverError.state.failure, serverError.state.message, serverError.state.postCount], ["failed", "这次请求未通过上游内容审核，请调整表述后重试。", 1]);

  const unknownServerError = harness();
  await unknownServerError.send({ error: "LLM_UPSTREAM_RESULT_UNKNOWN", code: "LLM_UPSTREAM_RESULT_UNKNOWN" });
  await unknownServerError.completion;
  check("unknown data.error preserves the production no-resend explanation", /最终结果暂未确认.*避免重复发送/u.test(unknownServerError.state.message));
  check("unknown data.error terminates without automatic resubmission", [unknownServerError.state.failure, unknownServerError.state.postCount], ["failed", 1]);

  const stopped = harness();
  await stopped.send({ choices: [{ delta: { content: "kept before stop", reasoning_content: "kept reasoning" } }] });
  await stopped.stop();
  await stopped.completion;
  check("user stop has precedence over post-SSE unknown classification", stopped.state.failure, "user_stopped");
  check("user stop preserves text and clears timers without resubmitting", [stopped.state.text, stopped.clock.scheduled.size, stopped.state.postCount], ["kept before stop", 0, 1]);
  check("user stop preserves reasoning and the original input", [stopped.state.reasoning, stopped.state.input], ["kept reasoning", "original user input"]);

  const preSseClock = new FakeClock();
  const preSseController = new AbortController();
  let preSsePostCount = 0;
  const preSseSubmit = () => { preSsePostCount++; return new ReadableStream<Uint8Array>().getReader(); };
  const preSseReader = preSseSubmit();
  const preSseRead = readChatStreamChunk(preSseReader, preSseController.signal, 310_000, preSseClock);
  preSseController.abort();
  let preSseOutcome = "";
  let preSseMessage = "";
  try { await preSseRead; assert.fail("pre-SSE abort must reject the pending read"); }
  catch (error) {
    preSseOutcome = classifyChatStreamFailure({ sseStarted: false, userStopped: false, watchdogAborted: true, signalAborted: preSseController.signal.aborted, abortLike: error instanceof Error && error.name === "AbortError" });
    if (preSseOutcome === "aborted" || preSseOutcome === "result_unknown") preSseMessage = automaticStopMessage;
  } finally { closeChatStreamReader(preSseReader, preSseController, true); }
  check("pre-SSE automatic abort uses the production shared unknown-result message", [preSseOutcome, preSseMessage], ["aborted", CHAT_STREAM_RESULT_UNKNOWN_MESSAGE]);
  check("pre-SSE automatic abort discourages replay and never resubmits", [/最终结果暂未确认.*避免重复发送/u.test(preSseMessage), preSsePostCount, preSseClock.scheduled.size], [true, 1, 0]);

  for (const mode of ["watchdog", "transport_abort"] as const) {
    const preHeadersClock = new FakeClock();
    const preHeadersController = new AbortController();
    let fetchCount = 0;
    let watchdogAborted = false;
    const originalFetch = globalThis.fetch;
    const preHeadersWatchdog = createChatStreamWatchdog({ setTimeout: preHeadersClock.setTimeout, clearTimeout: preHeadersClock.clearTimeout,
      onExpire: () => { watchdogAborted = true; } });
    try {
      globalThis.fetch = async (_url, options) => {
        fetchCount++;
        assert.equal(options?.method, "POST");
        const signal = options?.signal;
        assert.ok(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("pre-headers abort", "AbortError")), { once: true });
        });
      };
      preHeadersWatchdog.register(`pre-headers-${mode}`, preHeadersController, "ordinary-agent");
      const pendingFetch = fetchWithRetry("https://chat-behavior.invalid/api/llm", { method: "POST", signal: preHeadersController.signal }, 0)
        .then(() => { throw new Error("mock must remain pending until abort"); }, error => {
          const outcome = classifyChatStreamFailure({ sseStarted: false, userStopped: false, watchdogAborted, signalAborted: preHeadersController.signal.aborted, abortLike: isAbortLikeError(error, preHeadersController.signal) });
          return { outcome, message: outcome === "aborted" || outcome === "result_unknown" ? automaticStopMessage : "" };
        });
      if (mode === "watchdog") preHeadersClock.advanceTo(300_000);
      else { preHeadersClock.advanceTo(45_000); preHeadersController.abort(); }
      const outcome = await pendingFetch;
      check(`${mode} before response headers keeps an unknown-result explanation`, outcome, { outcome: "aborted", message: CHAT_STREAM_RESULT_UNKNOWN_MESSAGE });
      check(`${mode} before headers makes exactly one POST and disables production retry UI`, [fetchCount, messageRetryState(outcome.message), preHeadersClock.scheduled.size], [1, { unknown: true, retry: false }, 0]);
    } finally {
      globalThis.fetch = originalFetch;
      preHeadersWatchdog.clearAll();
    }
  }

  for (const [agentId, deadline] of [["ordinary-agent", 300_000], [STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, 2_400_000], [STORY_DIRECTOR_MOVIE_AGENT_ID, 2_400_000]] as const) {
    const bounded = harness({ agentId });
    for (let at = 5_000; at < deadline; at += 5_000) {
      await bounded.advance(at);
      await bounded.send(": heartbeat\n\n");
    }
    check(`${agentId} remains active immediately before its absolute deadline`, bounded.state.finalized, false);
    await bounded.advance(deadline);
    await bounded.completion;
    check(`${agentId} heartbeats cannot reset the absolute deadline`, [bounded.state.watchdogAborted, bounded.state.failure, bounded.state.postCount], [true, "result_unknown", 1]);
    check(`${agentId} deadline cleanup releases all timers`, bounded.clock.scheduled.size, 0);
  }

  const sharedClock = new FakeClock();
  const left = harness({ clock: sharedClock });
  const right = harness({ clock: sharedClock });
  await left.stop();
  await left.completion;
  check("one stream cleanup does not abort a second controller", right.controller.signal.aborted, false);
  check("one stream cleanup preserves the second watchdog", right.watchdog.size(), 1);
  await right.advance(65_000);
  await right.send({ choices: [{ delta: { content: "independent answer" } }] });
  await right.send("data: [DONE]\n\n");
  await right.completion;
  check("the second controller completes independently", [right.state.text, right.state.failure, right.state.postCount], ["independent answer", null, 1]);
  check("both controller finalizers release their own readers", [left.state.cancelCount, right.state.cancelCount, sharedClock.scheduled.size], [1, 1, 0]);

  check("pre-SSE ordinary exceptions retain failed classification", classifyChatStreamFailure({ sseStarted: false, userStopped: false, watchdogAborted: false, signalAborted: false, abortLike: false }), "failed");
  check("pre-SSE aborts retain aborted classification", classifyChatStreamFailure({ sseStarted: false, userStopped: false, watchdogAborted: false, signalAborted: true, abortLike: true }), "aborted");
  console.log(JSON.stringify({ status: "passed", assertions: checks.length, realReadableStreams: true, fakeClock: true, networkCalls: 0, providerCalls: 0, checks }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
