import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as recovery from "../src/contexts/chat-recovery-policy";
import { classifyError } from "../src/lib/chat-pipeline";
import { knownChatFailureMessage } from "../src/lib/chat-customer-failure";
import { isAbortLikeError } from "../src/contexts/chat-utils";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";
import { projectChatRequestHistory, readPersistedAssistantMessageId } from "../src/lib/chat-regeneration-policy";

// Execute production sendLLMMessage, customer error mapping and composer
// handleSend together. All transport is in-memory; no provider/auth/DB is used.
function initializer(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let value: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      value = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(value, `missing production initializer ${name}`);
  return value.getText(source);
}
const appFile = "src/contexts/app-context.tsx";
const viewFile = "src/components/chat-view.tsx";
const production = {
  customerStreamError: initializer(appFile, "customerStreamError"),
  sendLLMMessage: initializer(appFile, "sendLLMMessage"),
  handleSend: initializer(viewFile, "handleSend"),
};
const quiet = { log() {}, warn() {}, error() {} };
type Mode = "success" | "unknown" | "eof" | "network" | "watchdog" | "stop" | "balance" | "site402" | "relay402" | "untyped402";
const checks: string[] = [];
async function scenario(mode: Mode) {
  const controller = new AbortController();
  const userStopped = new Set<string>(), watchdog = new Set<string>();
  const agent = { id: "fixture-agent", name: "测试智能体", model: "fixture", is_active: true, deepThinkingType: 0 };
  const conversation = { id: "fixture-conv", agentId: agent.id, messages: [
    { id: "edit-user", role: "user", content: "A", timestamp: 1 },
    { id: "current-assistant", role: "assistant", content: "", timestamp: 2, isStreaming: true },
  ] };
  const events: string[] = [], warnings: string[] = [], actions: Record<string, unknown>[] = [];
  let submissions = 0, input = "A", editing: string | null = "edit-user";
  const context = vm.createContext({
    Error, TypeError, Date, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, DOMException,
    crypto: globalThis.crypto, console: quiet, ...recovery, SseEventStreamDecoder,
    projectChatRequestHistory, readPersistedAssistantMessageId, isAbortLikeError, classifyError, knownChatFailureMessage,
    state: { agents: [agent], activeAgentId: agent.id, streamingConvIds: [], auth: { token: "fixture", user: { id: "fixture-owner", role: "admin" } } },
    activeConv: conversation, authRef: { current: { token: "fixture" } },
    getOrCreateAbortController: () => controller,
    abortControllerMap: { current: new Map([[conversation.id, controller]]) },
    userAbortedSet: { current: userStopped }, watchdogAbortedSet: { current: watchdog },
    streamingConvIdsRef: { current: new Set() }, isStreamingRef: { current: false },
    clientPerformanceNow: () => 1, markChatStreamLifecycle() {}, resetTypewriterState() {}, finalizeAbortController() {},
    isStreamDebugEnabled: () => false, isImageGenerationModelName: () => false, getHybridImageConfig: () => undefined,
    needsCollabPrompt: () => false, annotateCollabMessages: (values: unknown) => values,
    appendImageMemoryToMessage: (message: { content: string }) => message.content,
    hasStoryboardNarrativeRuntimeContract: () => false, officialStoryboardDirectorIdentity: () => undefined,
    fetchCredits: async () => {}, toLlmImageUrl: (value: string) => value,
    setTimeout: (callback: () => void, ms: number) => ms === 500 ? 0 : setTimeout(callback, ms), clearTimeout,
    window: { setTimeout() {}, dispatchEvent: (event: { type: string }) => events.push(event.type) },
    CustomEvent: class { constructor(readonly type: string, readonly detail: unknown) {} },
    toast: { warning: (value: string) => warnings.push(value), info: (value: string) => warnings.push(value) },
    inputValue: input, editingMessageId: editing, pendingImages: [], pendingImageScopeRef: { current: { key: "same-scope" } },
    sendDebounceRef: { current: false }, SEND_DEBOUNCE_MS: 500, inputRef: { current: null },
    isConvStreaming: () => false, resumeAutoFollow() {}, canSwitchAssistant: false, bipAgentId: undefined,
    webSearchOverride: false, chatModelOverride: undefined, FREE_CHAT_AGENT_ID: "free", FREE_CHAT_DEEP_THINKING_TYPE: 0,
    shouldAutoEnableWebSearch: () => false, setPendingImages() {}, setShowMentionDropdown() {},
    setInputValue: (value: string | ((current: string) => string)) => { input = typeof value === "function" ? value(input) : value; },
    setEditingMessageId: (value: string | null) => { editing = value; },
    fetchWithRetry: async (_url: string, _request: RequestInit, retries: number) => {
      submissions++;
      assert.equal(retries, 0, "a generation submission cannot retry automatically");
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "watchdog" || mode === "stop") {
        (mode === "stop" ? userStopped : watchdog).add(conversation.id);
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }
      if (mode.endsWith("402")) return Response.json({
        error: "Payment Required", ...(mode === "site402" ? { code: "INSUFFICIENT_CREDITS" }
          : mode === "relay402" ? { code: "LLM_UPSTREAM_BALANCE" } : {}),
      }, { status: 402 });
      const frames = mode === "unknown"
        ? [{ error: "stream disconnected; balance unclear", code: "LLM_UPSTREAM_RESULT_UNKNOWN" }]
        : mode === "balance" ? [{ error: "余额不足", code: "LLM_UPSTREAM_BALANCE" }]
        : [{ choices: [{ delta: { content: "已收到正文" } }] }];
      const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + (mode === "success" ? "data: [DONE]\n\n" : "");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  context.dispatch = (action: Record<string, unknown>) => actions.push(action);
  context.throttledDispatchUpdate = (payload: unknown) => context.dispatch({ type: "UPDATE_MESSAGE", payload });
  context.settleTypewriterUpdate = async (payload: unknown) => context.dispatch({ type: "UPDATE_MESSAGE", payload });
  for (const [name, expression] of Object.entries(production)) vm.runInContext(ts.transpileModule(`globalThis.${name} = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  let result: boolean | undefined;
  context.sendMessage = async () => {
    result = await context.sendLLMMessage(conversation.id, "current-assistant", "A", conversation, agent, undefined, undefined, undefined, undefined, "edit-user");
    return result;
  };
  await context.handleSend();
  assert.equal(submissions, 1, `${mode}: exactly one submission`);
  const unknown = ["unknown", "eof", "network", "watchdog"].includes(mode);
  assert.equal(result, mode === "success" || unknown, `${mode}: handled does not mean successful`);
  if (unknown) {
    assert.equal(input, "", `${mode}: must not restore submitted text as unsent`);
    assert.equal(editing, null, `${mode}: must not restore the old edit operation`);
    assert.equal(warnings.length, 0, `${mode}: no misleading not-sent warning`);
    assert.ok(actions.some(action => action.type === "MARK_MESSAGE_ERROR" && /最终结果暂未确认/u.test(String((action.payload as { error?: unknown })?.error))), `${mode}: visible unknown error remains`);
  }
  if (mode === "balance" || mode === "relay402") {
    assert.ok(actions.some(action => /模型中转账户余额或额度不足/u.test(JSON.stringify(action))), "explicit relay cause remains readable");
    assert.equal(events.includes("insufficient-balance"), false, "relay failure cannot open site-credit recharge");
  }
  if (mode === "site402") {
    assert.ok(actions.some(action => /站内积分不足/u.test(JSON.stringify(action))));
    assert.deepEqual(events, ["insufficient-balance"]);
  }
  if (mode === "untyped402") assert.equal(events.length, 0, "HTTP status alone cannot identify site credits");
  checks.push(mode);
}

async function main() {
  for (const mode of ["success", "unknown", "eof", "network", "watchdog", "stop", "balance", "site402", "relay402", "untyped402"] as Mode[]) await scenario(mode);
  assert.equal(classifyError({ code: "LLM_UPSTREAM_RESULT_UNKNOWN", message: "balance" }).class, "network");
  assert.equal(classifyError({ code: "LLM_UPSTREAM_BALANCE", message: "LLM_UPSTREAM_RESULT_UNKNOWN" }).class, "network");
  assert.match(knownChatFailureMessage({ code: "LLM_UPSTREAM_BALANCE", error: "LLM_UPSTREAM_RESULT_UNKNOWN" }) || "", /最终结果暂未确认/u);
  assert.match(knownChatFailureMessage({ code: "LLM_UPSTREAM_BALANCE", error: { code: "LLM_UPSTREAM_RESULT_UNKNOWN" } }) || "", /最终结果暂未确认/u);
  for (const code of ["LLM_UPSTREAM_BALANCE", "LLM_UPSTREAM_BILLING", "LLM_UPSTREAM_AUTH", "LLM_UPSTREAM_BUSY", "LLM_UPSTREAM_CONCURRENCY_LIMIT"]) {
    const message = knownChatFailureMessage({ code }) || "";
    assert.ok(message, `stable server code remains readable: ${code}`);
    assert.doesNotMatch(message, /未扣费|未调用模型|请补充站内积分/u);
  }
  assert.match(classifyError(new Error("402 Payment Required")).userMessage, /计费状态/u);
  assert.doesNotMatch(classifyError(new Error("402 Payment Required")).userMessage, /请充值/u);
  const view = readFileSync(viewFile, "utf8");
  assert.match(view, /onContinue=\{msg\.role === "assistant" && !msg\.isStreaming && !isChatOutcomeUnknown\(msg\)/u);
  console.log(JSON.stringify({ passed: true, checks, productionComposerAndTransport: true, networkCalls: 0, providerCalls: 0, databaseWrites: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
