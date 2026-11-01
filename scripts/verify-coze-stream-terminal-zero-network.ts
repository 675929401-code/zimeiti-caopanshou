import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as recovery from "../src/contexts/chat-recovery-policy";
import { isAbortLikeError, isLocalConvId } from "../src/contexts/chat-utils";
import { knownChatFailureMessage } from "../src/lib/chat-customer-failure";
import { parseThinkTags } from "../src/lib/think-instruction";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

// Run the production callback and controller helpers, not a duplicate consumer.
// Only transport, dispatch/typewriter output and in-memory state/refs are replaced.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appFile = path.join(root, "src/contexts/app-context.tsx");
const source = ts.createSourceFile(appFile, readFileSync(appFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name: string): string {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, `missing production initializer ${name}`);
  return expression.getText(source);
}
const production = Object.fromEntries([
  "getOrCreateAbortController", "finalizeAbortController", "forgetPendingLocalConversation", "customerStreamError", "sendCozeMessage",
].map(name => [name, initializer(name)]));
const quiet = { log() {}, warn() {}, error() {} };
const text = "已接收的正文";
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const delta = frame("conversation.message.delta", { content: text });
const guardMetadata = `data: ${JSON.stringify({ type: "stream_delivery", stream_delivery: "buffered", stream_delivery_reason: "server_guard_response" })}\n\n`;
const guardHeaders = { "X-Stream-Delivery": "buffered", "X-Stream-Delivery-Reason": "server_guard_response" };
type Step = string | Uint8Array;
type Scenario = {
  name: string;
  steps: Step[];
  unknown?: boolean;
  stopped?: boolean;
  headers?: Record<string, string>;
  expectedContent?: string;
  rename?: boolean;
  cancelFailure?: "throw" | "reject" | "hang";
  settleFailure?: boolean;
  userStopAtSettle?: boolean;
  replaceControllerAtSettle?: boolean;
  stale?: boolean;
  expectedReads?: number;
  reasoning?: string;
};
type Action = { type: string; payload?: { conversationId?: string; messageId?: string; content?: string; error?: string; isStreaming?: boolean; oldId?: string; newId?: string; reasoningContent?: string } };
const checks: string[] = [];

async function scenario(test: Scenario) {
  const convId = test.rename ? "local_fixture" : "fixture-conv";
  const assistantId = "fixture-assistant";
  const actions: Action[] = [];
  const controllers = new Map<string, AbortController>();
  const userAborted = new Set<string>(), watchdogAborted = new Set<string>();
  const pending = new Map([[convId, { id: convId }]]);
  const streamingRef = { current: true };
  const legacyControllerRef: { current: AbortController | null } = { current: null };
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const synchronizations: string[] = [];
  let timerSequence = 0, reads = 0, cancellations = 0, submissions = 0, creditsReads = 0;
  let ownedController: AbortController | undefined;
  let replacementController: AbortController | undefined;
  const replaceController = () => {
    replacementController = new AbortController();
    controllers.set(convId, replacementController);
    legacyControllerRef.current = replacementController;
    userAborted.add(convId);
    watchdogAborted.add(convId);
  };
  const reader = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      reads++;
      const step = test.steps[reads - 1] ?? "EOF";
      if (step === "EOF") return Promise.resolve({ done: true, value: undefined });
      if (step === "READ_ERROR") return Promise.reject(new TypeError("fixture read disconnected"));
      if (typeof step === "string" && ["WATCHDOG", "ABORT", "USER_STOP", "TIMEOUT", "STALE_CONTROLLER"].includes(step)) {
        queueMicrotask(() => {
          assert.ok(ownedController);
          if (step === "TIMEOUT") {
            const timeout = [...timers.values()].find(timer => timer.ms === 310_000);
            assert.ok(timeout, "production read timeout is armed");
            timeout.callback();
            return;
          }
          if (step === "USER_STOP") userAborted.add(convId);
          if (step === "WATCHDOG") watchdogAborted.add(convId);
          if (step === "STALE_CONTROLLER") replaceController();
          ownedController.abort();
        });
        // A stalled browser reader is interrupted by the real abort/timeout helper.
        return new Promise(() => {});
      }
      return Promise.resolve({ done: false, value: typeof step === "string" ? new TextEncoder().encode(step) : step });
    },
    cancel(): Promise<void> {
      cancellations++;
      if (test.cancelFailure === "throw") throw new Error("fixture cleanup throw");
      if (test.cancelFailure === "reject") return Promise.reject(new Error("fixture cleanup rejection"));
      if (test.cancelFailure === "hang") return new Promise(() => {});
      return Promise.resolve();
    },
  };
  const context = vm.createContext({
    Error, TypeError, Date, Headers, TextEncoder, TextDecoder, AbortController, DOMException,
    crypto: globalThis.crypto, console: quiet, ...recovery, SseEventStreamDecoder,
    isAbortLikeError, isLocalConvId, knownChatFailureMessage, parseThinkTags,
    authRef: { current: { token: "fixture", user: { id: "fixture-owner" } } },
    abortControllerMap: { current: controllers }, abortControllerRef: legacyControllerRef,
    userAbortedSet: { current: userAborted }, watchdogAbortedSet: { current: watchdogAborted },
    streamingConvIdsRef: { current: new Set([convId]) }, isStreamingRef: streamingRef,
    pendingLocalConversationsRef: { current: pending },
    streamWatchdogRef: { current: { register() {}, clear() {} } },
    markChatStreamLifecycle() {}, resetTypewriterState() {}, isStreamDebugEnabled: () => false,
    setTimeout: (callback: () => void, ms: number) => { const id = ++timerSequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    syncConversationToServer: (id: string) => synchronizations.push(id),
    fetchCredits: async () => { creditsReads++; },
    fetchWithRetry: async (url: string, request: RequestInit) => {
      submissions++;
      assert.equal(url, "/api/chat");
      ownedController = controllers.get(convId);
      assert.ok(ownedController);
      assert.equal(request.signal, ownedController.signal);
      const body = JSON.parse(String(request.body));
      assert.equal(body.client_request_id, (request.headers as Record<string, string>)["Idempotency-Key"]);
      assert.match(body.client_request_id, /^chat_[0-9a-f-]+$/u);
      assert.equal(body.conversationId, convId);
      return { ok: true, status: 200, headers: new Headers({ "Content-Type": "text/event-stream", ...test.headers }), body: { getReader: () => reader } };
    },
    dispatch: (action: Action) => actions.push(action),
    throttledDispatchUpdate: (payload: Action["payload"]) => actions.push({ type: "UPDATE_MESSAGE", payload }),
    settleTypewriterUpdate: async (payload: Action["payload"]) => {
      if (test.replaceControllerAtSettle) replaceController();
      if (test.userStopAtSettle) {
        userAborted.add(convId);
        ownedController?.abort();
        throw new DOMException("fixture user stop", "AbortError");
      }
      if (test.settleFailure) throw new Error("fixture typewriter cleanup failed");
      actions.push({ type: "UPDATE_MESSAGE", payload });
    },
  });
  for (const [name, expression] of Object.entries(production)) {
    vm.runInContext(ts.transpileModule(`globalThis.${name} = ${expression};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
  }
  await context.sendCozeMessage(convId, assistantId, "fixture question", { id: convId }, { id: "fixture-agent", botId: "fixture-bot", name: "fixture", enableThinkTags: true }, undefined, "fixture-user");
  await Promise.resolve(); // Observe rejected cleanup promises without awaiting hung cleanup.
  assert.equal(submissions, 1, `${test.name}: exactly one in-memory submission`);
  assert.equal(cancellations, 1, `${test.name}: transport cleanup is attempted once`);
  const failures = actions.filter(action => action.type === "MARK_MESSAGE_ERROR");
  const final = actions.filter(action => action.type === "UPDATE_MESSAGE").at(-1)?.payload;
  assert.ok(final, `${test.name}: final assistant update exists`);
  assert.equal(actions.some(action => action.type === "DELETE_MESSAGE"), false, `${test.name}: assistant remains`);
  if (test.unknown) {
    assert.ok(failures.some(action => action.payload?.messageId === assistantId && action.payload.error === recovery.CHAT_STREAM_RESULT_UNKNOWN_MESSAGE), `${test.name}: same assistant has unknown outcome`);
    assert.ok(failures.every(action => action.payload?.messageId === assistantId), `${test.name}: the submitted user message is not relabeled as retryable`);
    assert.ok(final.content?.includes(recovery.CHAT_STREAM_RESULT_UNKNOWN_MESSAGE));
    assert.doesNotMatch(final.content || "", /请稍后重试|发送失败|未扣费|未调用模型/u);
  } else {
    assert.equal(failures.length, 0, `${test.name}: no false unknown error`);
    assert.doesNotMatch(final.content || "", /最终结果暂未确认/u);
  }
  if (test.stopped) assert.ok(final.content?.endsWith("[已终止]"), `${test.name}: explicit user stop wins`);
  if (test.expectedContent) assert.ok(final.content?.includes(test.expectedContent), `${test.name}: received content is retained`);
  if (test.reasoning) assert.equal(final.reasoningContent, test.reasoning);
  if (test.expectedReads !== undefined) assert.equal(reads, test.expectedReads, `${test.name}: no read after trusted completion`);
  if (test.stale) {
    assert.equal(controllers.get(convId), replacementController, "older completion cannot delete the newer controller");
    assert.equal(legacyControllerRef.current, replacementController);
    assert.ok(userAborted.has(convId), "older catch cannot consume the newer user-stop reason");
    assert.ok(watchdogAborted.has(convId), "older catch cannot consume the newer watchdog reason");
    assert.equal(replacementController?.signal.aborted, false);
    assert.equal(streamingRef.current, true);
    assert.equal(actions.some(action => action.type === "SET_CONV_STREAMING"), false);
    assert.equal([...timers.values()].some(timer => timer.ms === 500), false);
  } else {
    assert.equal(controllers.size, 0);
    assert.equal(streamingRef.current, false);
    assert.equal(userAborted.size, 0);
    assert.equal(watchdogAborted.size, 0);
  }
  if (test.rename) {
    const renameIndex = actions.findIndex(action => action.type === "RENAME_CONVERSATION_ID");
    assert.ok(renameIndex >= 0, "local conversation still receives the Coze conversation ID");
    assert.equal(actions[renameIndex].payload?.oldId, convId);
    assert.equal(actions[renameIndex].payload?.newId, "coze-fixture");
    assert.ok(actions.slice(0, renameIndex).some(action => action.type === "UPDATE_MESSAGE" && action.payload?.conversationId === convId));
    assert.ok(actions.some(action => action.type === "SET_MESSAGE_STREAMING" && action.payload?.conversationId === "coze-fixture"));
    assert.equal(pending.has(convId), false);
    for (const timer of timers.values()) if (timer.ms === 500) timer.callback();
    assert.deepEqual(synchronizations, ["coze-fixture"]);
  }
  assert.equal([...timers.values()].some(timer => timer.ms === 310_000), false, `${test.name}: no read timeout leaks`);
  assert.ok(creditsReads <= 1);
  checks.push(test.name);
}

async function main() {
  const terminals = ["data: [DONE]\n\n", frame("done", {}), frame("conversation.chat.completed", { usage: { total_tokens: 2 } })];
  for (const [index, terminal] of terminals.entries()) {
    await scenario({ name: `trusted-terminal-${index + 1}`, steps: [delta, terminal, "READ_ERROR"], expectedContent: text, expectedReads: 2 });
  }
  await scenario({ name: "split-utf8-terminal", steps: [...Buffer.from(delta + terminals[0])].map(byte => Uint8Array.of(byte)), expectedContent: text });
  await scenario({ name: "partial-eof", steps: [delta, "EOF"], unknown: true, expectedContent: text });
  await scenario({ name: "empty-eof", steps: ["EOF"], unknown: true });
  await scenario({ name: "message-completed-is-not-turn-completed", steps: [frame("conversation.message.completed", { content: text }), "EOF"], unknown: true, expectedContent: text });
  await scenario({ name: "billing-and-heartbeat-are-not-terminal", steps: [delta, `data: ${JSON.stringify({ billing_complete: true })}\n\n: heartbeat\n\n`, "EOF"], unknown: true, expectedContent: text });
  await scenario({ name: "completion-words-in-content-are-not-terminal", steps: [frame("conversation.message.delta", { content: "[DONE] event: done conversation.chat.completed" }), "EOF"], unknown: true, expectedContent: "[DONE] event: done conversation.chat.completed" });
  await scenario({ name: "trusted-guard-finite-eof", steps: [guardMetadata, delta, "EOF"], headers: guardHeaders, expectedContent: text });
  await scenario({ name: "generic-buffered-eof", steps: [delta, "EOF"], headers: { "X-Stream-Delivery": "buffered" }, unknown: true, expectedContent: text });
  await scenario({ name: "guard-header-without-metadata", steps: [delta, "EOF"], headers: guardHeaders, unknown: true, expectedContent: text });
  await scenario({ name: "guard-metadata-without-header", steps: [guardMetadata, delta, "EOF"], unknown: true, expectedContent: text });
  await scenario({ name: "guard-reason-without-delivery-header", steps: [guardMetadata, delta, "EOF"], headers: { "X-Stream-Delivery-Reason": "server_guard_response" }, unknown: true, expectedContent: text });
  await scenario({ name: "other-buffered-reason", steps: [guardMetadata, delta, "EOF"], headers: { ...guardHeaders, "X-Stream-Delivery-Reason": "coze_unbounded_usage_requires_atomic_settlement" }, unknown: true, expectedContent: text });
  await scenario({ name: "guard-read-error", steps: [guardMetadata, delta, "READ_ERROR"], headers: guardHeaders, unknown: true, expectedContent: text });
  for (const mode of ["READ_ERROR", "WATCHDOG", "ABORT", "TIMEOUT"] as const) {
    await scenario({ name: `partial-${mode.toLowerCase()}`, steps: [delta, mode], unknown: true, expectedContent: text });
    await scenario({ name: `empty-${mode.toLowerCase()}`, steps: [mode], unknown: true });
  }
  await scenario({ name: "partial-user-stop", steps: [delta, "USER_STOP"], stopped: true, expectedContent: text });
  await scenario({ name: "empty-user-stop", steps: ["USER_STOP"], stopped: true });
  await scenario({ name: "user-stop-after-terminal-wins", steps: [delta, terminals[0]], stopped: true, userStopAtSettle: true, expectedContent: text });
  await scenario({ name: "stale-controller", steps: [delta, "STALE_CONTROLLER"], unknown: true, stale: true, expectedContent: text });
  await scenario({ name: "stale-controller-after-terminal", steps: [delta, terminals[0]], replaceControllerAtSettle: true, stale: true, expectedContent: text });
  for (const cancelFailure of ["throw", "reject", "hang"] as const) {
    await scenario({ name: `terminal-cleanup-${cancelFailure}`, steps: [delta, terminals[0]], cancelFailure, expectedContent: text });
  }
  await scenario({ name: "terminal-typewriter-error", steps: [delta, terminals[0]], settleFailure: true, expectedContent: text });
  await scenario({ name: "guard-typewriter-error-after-clean-eof", steps: [guardMetadata, delta, "EOF"], headers: guardHeaders, settleFailure: true, expectedContent: text });
  await scenario({ name: "reasoning-read-error", steps: [frame("conversation.message.delta", { reasoning_content: "已接收思考" }), "READ_ERROR"], unknown: true, reasoning: "已接收思考" });
  for (const terminal of [true, false]) {
    await scenario({ name: `local-conversation-rename-${terminal ? "complete" : "unknown"}`, steps: [frame("conversation.chat.created", { conversation_id: "coze-fixture" }), delta, ...(terminal ? [terminals[0]] : ["EOF"])], unknown: !terminal, rename: true, expectedContent: text });
  }
  console.log(JSON.stringify({ passed: true, checks, checkCount: checks.length, productionCallbackAndControllerHelpers: true, productionSseDecoder: true, networkCalls: 0, providerCalls: 0, databaseWrites: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
