import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { initialState, reducer, type Action, type AppState } from "../src/contexts/chat-reducer";
import { releaseConversationSend, tryAcquireConversationSend } from "../src/contexts/pending-send-lock";
import { chatBranchContext, persistedChatMessageId } from "../src/lib/chat-regeneration-policy";
import { getHybridImageConfig, isImageGenerationModelName, shouldTriggerHybridImage } from "../src/lib/hybrid-image-routing";
import type { Agent, Conversation } from "../src/types/coze";

// Execute the real routing callback and retired handoff against the real
// reducer. Every transport, storage, navigation and billing hook is a trap.
const file = "src/contexts/app-context.tsx";
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name: string): string {
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `missing production callback ${name}`);
  return expression.getText(source);
}

const expected = "独立 AI 生图工作台已下线，此入口暂不支持生成图片。你的原始提示词已保留在当前对话中。";
const results: string[] = [];
async function scenario(mode: "image-model" | "hybrid-always" | "hybrid-auto" | "retry", keepOtherStream = true) {
  const original = "请生成一张图片\n原始提示词、颜色与构图全部保留。";
  const agent = {
    id: "fixture-agent", name: "fixture", source: "llm",
    model: mode === "image-model" || mode === "retry" ? "gpt-image-1" : "fixture-text",
    ...(mode.startsWith("hybrid") ? { outputStyle: { hybridImageGeneration: {
      enabled: true, model: "gpt-image-1", routingMode: mode === "hybrid-always" ? "always" : "auto",
    } } } : {}),
  } as Agent;
  const retry = mode === "retry";
  const conversation = {
    id: "fixture-conv", agentId: agent.id, messagesLoaded: true,
    messages: retry ? [{ id: "existing-user", role: "user", content: original, timestamp: 1 }] : [],
  } as Conversation;
  let state: AppState = {
    ...initialState, agents: [agent], activeAgentId: agent.id, activeConversationId: conversation.id,
    conversations: [conversation], cashBalance: 42,
    credits: { ...initialState.credits, total: 100, remaining: 100 },
    streamingConvIds: new Set(keepOtherStream ? ["unrelated-conv"] : []), isStreaming: keepOtherStream,
  };
  const beforeAgents = JSON.stringify(state.agents);
  const beforeCredits = JSON.stringify(state.credits);
  const actions: Action[] = [], errors: string[] = [], forbidden: string[] = [], resets: string[] = [];
  const pending = new Set<string>();
  const trap = (name: string) => () => { forbidden.push(name); throw new Error(`forbidden: ${name}`); };
  const streamingRef = { current: state.streamingConvIds };
  const context = vm.createContext({
    state, console: { log() {}, warn() {}, error() {} }, Date,
    streamingConvIdsRef: streamingRef, pendingSendConversationIdsRef: { current: pending },
    clientPerformanceNow: () => 1, tryAcquireConversationSend, releaseConversationSend,
    chatBranchContext, persistedChatMessageId, getHybridImageConfig, isImageGenerationModelName, shouldTriggerHybridImage,
    officialStoryboardDirectorIdentity: () => undefined, canSelectPublicChatModel: () => false,
    resetTypewriterState: ({ messageId }: { messageId: string }) => resets.push(messageId),
    dispatch: (action: Action) => {
      actions.push(action);
      state = reducer(state, action);
      streamingRef.current = state.streamingConvIds;
    },
    toast: { error: (message: string) => errors.push(message), success: trap("success-toast") },
    appendImageWorkbenchPromptTransfer: trap("retired-queue"),
    safeSet: trap("storage"), localStorage: { setItem: trap("storage") },
    fetch: trap("fetch"), fetchWithRetry: trap("provider"),
    fetchCredits: trap("credits"), rechargeCredits: trap("recharge"),
    sendLLMMessage: trap("llm"), sendCozeMessage: trap("coze"), sendCozeCodingMessage: trap("coze-coding"),
    setTimeout: trap("timer"), syncConversationToServer: trap("history-write"),
    window: { setTimeout: trap("navigation-timer"), location: { assign: trap("navigation"), replace: trap("navigation") }, localStorage: { setItem: trap("storage") } },
  });
  const javascript = ts.transpileModule(
    `sendImageGenMessage = (${initializer("sendImageGenMessage")}); sendMessage = (${initializer("sendMessage")});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  vm.runInContext(javascript, context);
  const handled = await context.sendMessage(original, undefined, undefined, undefined, undefined, undefined, undefined, retry, retry ? "existing-user" : undefined);
  assert.equal(handled, true, `${mode}: a handled local refusal must not restore the composer as a new unsent draft`);
  const messages = state.conversations[0].messages;
  const users = messages.filter(message => message.role === "user");
  assert.equal(users.length, 1, `${mode}: preserve one original user message`);
  assert.equal(users[0].content, original);
  assert.equal(users[0].error, undefined, "do not turn the original prompt into a retryable transport failure");
  const assistant = messages.find(message => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.content, expected);
  assert.equal(assistant.error, expected, "the refusal uses the existing local failure state");
  assert.equal(assistant.isStreaming, false);
  assert.equal(assistant.streamStatus, "");
  assert.equal(state.streamingConvIds.has(conversation.id), false);
  assert.equal(state.streamingConvIds.has("unrelated-conv"), keepOtherStream);
  assert.equal(state.isStreaming, keepOtherStream, "global streaming reflects only unrelated active conversations");
  assert.equal(pending.size, 0, "routing releases the pending-send lock");
  assert.equal(state.conversations[0].lastMessage, expected, "the local history preview shows the refusal");
  assert.equal(state.conversations[0].dirty, true);
  assert.equal(JSON.stringify(state.agents), beforeAgents, "model/agent visibility is unchanged");
  assert.equal(JSON.stringify(state.credits), beforeCredits);
  assert.equal(state.cashBalance, 42);
  assert.deepEqual(errors, [expected]);
  assert.equal(resets.filter(id => id === assistant.id).length, 2, "initialize and clean this message's typewriter state");
  assert.deepEqual(forbidden, [], "no queue, transport, navigation, billing, history write or timer");
  assert.equal(actions.some(action => ["DELETE_MESSAGE", "DELETE_MESSAGE_PAIR"].includes(action.type)), false);
  results.push(`${mode}:${keepOtherStream ? "other-stream-active" : "no-other-stream"}`);
}

async function main() {
  for (const mode of ["image-model", "hybrid-always", "hybrid-auto", "retry"] as const) await scenario(mode);
  await scenario("image-model", false);
  console.log(JSON.stringify({ passed: true, zeroNetwork: true, cases: results,
    persistenceBoundary: "Current conversation state and local history preview only; server-first messages have no new durable write." }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
