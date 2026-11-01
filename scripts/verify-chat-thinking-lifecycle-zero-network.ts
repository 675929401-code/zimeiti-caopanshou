import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as recovery from "../src/contexts/chat-recovery-policy";
import { classifyError } from "../src/lib/chat-pipeline";
import { knownChatFailureMessage } from "../src/lib/chat-customer-failure";
import { isAbortLikeError } from "../src/contexts/chat-utils";
import { parseThinkTags } from "../src/lib/think-instruction";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";
import { projectChatRequestHistory, readPersistedAssistantMessageId } from "../src/lib/chat-regeneration-policy";

// Execute the production consumer with controllable in-memory SSE reads.
// These are actual callback transitions, not a copy of its state machine.
const text = readFileSync("src/contexts/app-context.tsx", "utf8");
const ast = ts.createSourceFile("app-context.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name: string, call = false) {
  let value: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      value = call && ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(value, `production initializer required: ${name}`);
  return value.getText(ast);
}
const quiet = { log() {}, warn() {}, error() {} };
const tick = async () => { for (let index = 0; index < 3; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
const checks: string[] = [];
async function fixture(options: { tagged?: boolean } = {}) {
  const agent = { id: "fixture-agent", name: "测试智能体", model: "offline", source: "llm", enableThinkTags: !!options.tagged, deepThinkingType: 0 };
  const controller = new AbortController();
  const userStopped = new Set<string>();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let submissions = 0;
  const stream = new ReadableStream<Uint8Array>({ start(value) { upstream = value; } });
  const context = vm.createContext({
    Error, TypeError, Date, Response, ReadableStream, TextEncoder, TextDecoder, AbortController, DOMException,
    crypto: globalThis.crypto, console: quiet, ...recovery, SseEventStreamDecoder,
    projectChatRequestHistory, readPersistedAssistantMessageId, isAbortLikeError, parseThinkTags, classifyError, knownChatFailureMessage,
    state: { agents: [agent], streamingConvIds: [], auth: { token: "synthetic" } }, targetAgent: agent,
    authRef: { current: { token: "synthetic" } },
    getOrCreateAbortController: () => controller,
    abortControllerMap: { current: new Map([["fixture-conv", controller]]) },
    userAbortedSet: { current: userStopped }, watchdogAbortedSet: { current: new Set() },
    streamingConvIdsRef: { current: new Set() }, isStreamingRef: { current: false },
    clientPerformanceNow: () => 1, markChatStreamLifecycle() {}, resetTypewriterState() {}, finalizeAbortController() {},
    isStreamDebugEnabled: () => false, isImageGenerationModelName: () => false, getHybridImageConfig: () => undefined,
    needsCollabPrompt: () => false, annotateCollabMessages: (values: unknown) => values,
    appendImageMemoryToMessage: (message: { content: string }) => message.content,
    hasStoryboardNarrativeRuntimeContract: () => false, officialStoryboardDirectorIdentity: () => undefined,
    fetchCredits: async () => {}, toLlmImageUrl: (value: string) => value, toast: { warning() {} },
    setTimeout: (callback: () => void, ms: number) => ms === 500 ? 0 : setTimeout(callback, ms), clearTimeout,
    fetchWithRetry: async (_url: string, _request: RequestInit, retries: number) => {
      submissions++;
      assert.equal(retries, 0);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  function install(name: string, value: string) {
    vm.runInContext(ts.transpileModule(`globalThis.${name} = ${value};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
  }
  install("placeholder", initializer("assistantMessage"));
  const message = context.placeholder as { content: string; reasoningContent?: string; streamStatus: string; isStreaming: boolean; error?: string };
  const statuses = [message.streamStatus];
  context.dispatch = (action: { type: string; payload?: Record<string, unknown> }) => {
    const payload = action.payload || {};
    if (action.type === "UPDATE_MESSAGE") Object.assign(message, payload);
    if (action.type === "MARK_MESSAGE_ERROR") message.error = String(payload.error);
    if (action.type === "SET_MESSAGE_STREAMING") message.isStreaming = Boolean(payload.isStreaming);
    if (typeof payload.streamStatus === "string") statuses.push(payload.streamStatus);
  };
  context.throttledDispatchUpdate = (payload: Record<string, unknown>) => context.dispatch({ type: "UPDATE_MESSAGE", payload });
  context.settleTypewriterUpdate = async (payload: Record<string, unknown>) => context.dispatch({ type: "UPDATE_MESSAGE", payload });
  install("customerStreamError", initializer("customerStreamError"));
  install("sendLLMMessage", initializer("sendLLMMessage", true));
  const conversation = { id: "fixture-conv", agentId: agent.id, messages: [{ id: "user", role: "user", content: "测试", timestamp: 1 }] };
  const completion = context.sendLLMMessage(conversation.id, "assistant", "测试", conversation, agent);
  await tick();
  return { message, statuses,
    async push(value: unknown) { upstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); await tick(); },
    async done() { upstream.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); const result = await completion; assert.equal(submissions, 1); return result; },
    async stop() { userStopped.add(conversation.id); controller.abort(); const result = await completion; assert.equal(submissions, 1); return result; },
    async finishError() { const result = await completion; assert.equal(submissions, 1); return result; },
  };
}

async function main() {
  const live = await fixture();
  assert.equal(live.message.streamStatus, "智能体正在准备回复");
  await live.push({ type: "stream_delivery", stream_delivery: "live" });
  assert.equal(live.message.streamStatus, "智能体正在准备回复", "connection cannot prove reasoning");
  await live.push({ choices: [{ delta: { reasoning_content: " \n\t" } }] });
  assert.equal(live.message.streamStatus, "智能体正在准备回复", "whitespace cannot prove reasoning");
  assert.equal(Boolean(live.message.reasoningContent?.trim()), false);
  await live.push({ type: "generation_progress", received_chars: 10 });
  assert.equal(live.message.streamStatus, "智能体正在生成回复");
  await live.push({ type: "stream_delivery", stream_delivery: "buffered" });
  assert.equal(live.message.streamStatus, "智能体正在生成回复", "late delivery cannot regress generation to preparation");
  await live.push({ choices: [{ delta: { reasoning_content: "真实收到的思考" } }] });
  assert.equal(live.message.streamStatus, "智能体正在思考");
  assert.match(live.message.reasoningContent || "", /真实收到的思考/u);
  await live.push({ type: "stream_delivery", stream_delivery: "live" });
  await live.push({ type: "generation_progress", received_chars: 20 });
  assert.equal(live.message.streamStatus, "智能体正在思考", "late delivery/progress cannot reset real thinking");
  await live.push({ choices: [{ delta: { content: " " } }] });
  assert.equal(live.message.streamStatus, "智能体正在思考", "whitespace body cannot end thinking");
  await live.push({ choices: [{ delta: { content: "首段正文" } }] });
  assert.equal(live.message.streamStatus, "智能体正在回复");
  await live.push({ choices: [{ delta: { reasoning: "稍后收到的思考片段" } }] });
  assert.equal(live.message.streamStatus, "智能体正在回复", "late reasoning cannot reopen a body phase");
  assert.equal(await live.done(), true);
  assert.equal(live.message.isStreaming, false);
  assert.equal(live.message.error, undefined);
  checks.push("real-delta-stages", "whitespace-reasoning-not-thinking", "late-events-preserve-phase", "body-transition-and-success");

  const plain = await fixture();
  await plain.push({ type: "stream_delivery", stream_delivery: "buffered" });
  await plain.push({ choices: [{ delta: { content: "普通正文" } }] });
  await plain.done();
  assert.equal(plain.statuses.includes("智能体正在思考"), false);
  assert.equal(plain.message.streamStatus, "智能体正在回复");
  checks.push("no-reasoning-no-thinking-stage");

  const tagged = await fixture({ tagged: true });
  await tagged.push({ choices: [{ delta: { content: "<think>实际思考片段" } }] });
  assert.equal(tagged.message.streamStatus, "智能体正在思考");
  assert.equal(tagged.message.content.trim(), "");
  await tagged.push({ choices: [{ delta: { content: "</think>实际正文" } }] });
  assert.equal(tagged.message.streamStatus, "智能体正在回复");
  await tagged.done();
  checks.push("existing-think-tag-adapter-only-real-content");

  const unknown = await fixture();
  await unknown.push({ choices: [{ delta: { reasoning_content: "已有思考" } }] });
  await unknown.push({ error: "connection interrupted", code: "LLM_UPSTREAM_RESULT_UNKNOWN" });
  assert.equal(await unknown.finishError(), true);
  assert.match(unknown.message.error || "", /最终结果暂未确认/u);
  assert.equal(unknown.message.isStreaming, false);
  assert.match(unknown.message.reasoningContent || "", /已有思考/u);
  checks.push("unknown-keeps-received-reasoning-without-completion-claim");

  const stopped = await fixture();
  await stopped.push({ choices: [{ delta: { reasoning_content: "停止前的思考" } }] });
  assert.equal(await stopped.stop(), false);
  assert.equal(stopped.message.isStreaming, false);
  assert.match(stopped.message.error || "", /已终止|已停止接收/u);
  checks.push("user-stop-retains-original-outcome-contract");
  const messageSource = readFileSync("src/components/chat/message-item.tsx", "utf8");
  assert.match(messageSource, /message\.reasoningContent\?\.trim\(\) &&/u);
  assert.match(messageSource, /isThinking=\{!!message\.isStreaming && !hasVisibleText\}/u);
  assert.equal(statusesContainImplementationWords(live.statuses), false);
  console.log(JSON.stringify({ passed: true, productionConsumer: true, checks, networkCalls: 0, databaseWrites: 0, providerCalls: 0 }, null, 2));
}
function statusesContainImplementationWords(statuses: string[]) { return statuses.some(value => /模型|模式|已连接|等待完整/u.test(value)); }
main().catch(error => { console.error(error); process.exitCode = 1; });
